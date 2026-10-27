/**
 * Production two-lane seam tests.
 *
 * `runDispatchLanes` is the exact orchestration `push-dispatch/index.ts` uses on
 * every invocation. These tests drive it, not a re-implementation, so the
 * reviewed regression (a chat failure returning before the report lane ran)
 * cannot come back without failing here.
 *
 * Runs under Deno: `deno test supabase/functions/_shared/`.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runDispatchLanes, type DispatchLanesDeps } from "./dispatchLanes.ts";

const CHAT_OK = { claimed: 2, sent: 2, failed: 0 };
const REPORT_OK = { status: 200, body: { scanned: 5, suppressed: 1, sent: 4, pruned: 0, failed: 0 } };

function deps(overrides: Partial<DispatchLanesDeps> = {}): DispatchLanesDeps {
  return {
    dispatchChat: async () => ({ ...CHAT_OK }),
    dispatchReports: async () => ({ ...REPORT_OK, body: { ...REPORT_OK.body } }),
    ...overrides,
  };
}

Deno.test("a chat failure still runs the report lane to completion", async () => {
  const order: string[] = [];
  const result = await runDispatchLanes(deps({
    dispatchChat: async () => {
      order.push("chat");
      throw new Error("findback_claim_chat_external_wakes unavailable");
    },
    dispatchReports: async () => {
      order.push("reports");
      return { ...REPORT_OK, body: { ...REPORT_OK.body } };
    },
  }));

  assertEquals(order, ["chat", "reports"]);
  assertEquals(result.status, 200);
  assertEquals(result.body, { ...REPORT_OK.body, chat: { claimed: 0, sent: 0, failed: 0 }, chatError: "findback_claim_chat_external_wakes unavailable", degraded: ["chat"] });
  assertEquals(result.chat, { claimed: 0, sent: 0, failed: 0 });
  assertEquals(result.report.ok, true);
});

Deno.test("every report-lane status is preserved verbatim", async () => {
  for (const status of [200, 500, 502, 503]) {
    const result = await runDispatchLanes(deps({
      dispatchReports: async () => ({ status, body: { error: "lane-specific", scanned: 7, sent: 0 } }),
    }));
    assertEquals(result.status, status);
    assertEquals(result.body.error, "lane-specific");
    assertEquals(result.body.scanned, 7);
    assertEquals(result.body.chat, CHAT_OK);
    assertEquals("chatError" in result.body, false);
    assertEquals("degraded" in result.body, false);
  }
});

Deno.test("a report-lane failure is never reported as a chat outcome", async () => {
  const result = await runDispatchLanes(deps({
    dispatchReports: async () => {
      throw new Error("notifications read exploded");
    },
  }));

  assertEquals(result.status, 500);
  assertEquals(result.body.error, "report dispatch unavailable");
  assertEquals(result.body.chat, CHAT_OK);
  assertEquals("chatError" in result.body, false);
  assertEquals("degraded" in result.body, false);
  assertEquals(result.report.ok, false);
  if (!result.report.ok) assertEquals(result.report.error, "notifications read exploded");
});

Deno.test("a report body cannot overwrite the chat outcome", async () => {
  const result = await runDispatchLanes(deps({
    dispatchReports: async () => ({
      status: 200,
      body: { scanned: 1, chat: { claimed: 99, sent: 99, failed: 99 }, degraded: ["reports"], chatError: "fake" },
    }),
  }));
  assertEquals(result.body.chat, CHAT_OK);
  assertEquals("chatError" in result.body, false);
  assertEquals("degraded" in result.body, false);
});

Deno.test("a synchronous chat throw is contained like a rejection", async () => {
  const result = await runDispatchLanes(deps({
    dispatchChat: () => {
      throw new Error("chat config missing");
    },
  }));
  assertEquals(result.status, 200);
  assertEquals(result.body.degraded, ["chat"]);
  assertEquals(result.body.chatError, "chat config missing");
});

Deno.test("both lanes healthy: report body plus chat counts, no degraded field", async () => {
  const result = await runDispatchLanes(deps());
  assertEquals(result.status, 200);
  assertEquals(result.body, { ...REPORT_OK.body, chat: CHAT_OK });
  assertEquals(result.report.ok, true);
});

Deno.test("a throwing logger cannot stop either lane", async () => {
  let reports = 0;
  const result = await runDispatchLanes(deps({
    dispatchChat: async () => {
      throw new Error("denied");
    },
    dispatchReports: async () => {
      reports += 1;
      return { ...REPORT_OK, body: { ...REPORT_OK.body } };
    },
    log: () => {
      throw new Error("logger unavailable");
    },
  }));
  assertEquals(reports, 1);
  assertEquals(result.status, 200);
  assertEquals(result.body.degraded, ["chat"]);
});

Deno.test("a chat failure's exposed text is secret-safe in body and log", async () => {
  const logged: string[] = [];
  const secrets = [
    "sb_secret_AbCdEf1234567890",
    "hunter2",
    "hunter3",
    "abc123",
  ];
  const result = await runDispatchLanes(deps({
    dispatchChat: async () => {
      throw new Error(
        "fcm failed Bearer sb_secret_AbCdEf1234567890 at https://user:hunter2@example.com; "
          + "client_secret=hunter3 access_token=abc123",
      );
    },
    log: (line) => logged.push(line),
  }));
  assertEquals(result.status, 200);
  const text = JSON.stringify(result.body);
  const log = logged.join("\n");
  // Every fragment must be absent from BOTH sinks, not just the first two.
  for (const fragment of secrets) {
    assertEquals(text.includes(fragment), false, `body leaked ${fragment}`);
    assertEquals(log.includes(fragment), false, `log leaked ${fragment}`);
  }
});

// The reviewer's counterexample: a rejected chat lane is contained, but a
// never-settling one used to hold the invocation open forever, so the report lane
// never ran. A deadline is the only boundary that can cover a stalled dependency.
Deno.test("a hung chat lane cannot hold report dispatch open", async () => {
  const order: string[] = [];
  const started = Date.now();
  const result = await runDispatchLanes(deps({
    chatDeadlineMs: 25,
    dispatchChat: () => {
      order.push("chat");
      return new Promise(() => {});
    },
    dispatchReports: async () => {
      order.push("reports");
      return { ...REPORT_OK, body: { ...REPORT_OK.body } };
    },
  }));
  assertEquals(order, ["chat", "reports"]);
  assertEquals(result.status, 200);
  assertEquals(result.body.chat, { claimed: 0, sent: 0, failed: 0 });
  assertEquals(result.body.degraded, ["chat"]);
  assertEquals(typeof result.body.chatError, "string");
  assertEquals((result.body.chatError as string).includes("deadline"), true);
  // The deadline, not the lane, decided: this must not wait for the lane.
  assertEquals(Date.now() - started < 2_000, true);
});

Deno.test("a hung chat lane that later rejects does not become an unhandled rejection", async () => {
  let abandon: (reason: Error) => void = () => {};
  const result = await runDispatchLanes(deps({
    chatDeadlineMs: 10,
    dispatchChat: () => new Promise((_resolve, reject) => { abandon = reject; }),
  }));
  assertEquals(result.body.degraded, ["chat"]);
  abandon(new Error("late failure after the response"));
  // Give the abandoned promise a turn to settle on the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(result.status, 200);
});

// Wiring guard: the seam above is only meaningful while the production handler
// actually routes both lanes through it and has no chat-only early return.
Deno.test("the dispatcher routes both lanes through this seam", async () => {
  const source = await Deno.readTextFile(new URL("../push-dispatch/index.ts", import.meta.url));
  assertEquals(source.includes("runDispatchLanes({"), true);
  assertEquals(source.includes("dispatchChat:"), true);
  assertEquals(source.includes("dispatchReports:"), true);
  assertEquals(source.includes("Response.json(lanes.body, { status: lanes.status })"), true);
  assertEquals(source.includes("chat dispatch unavailable"), false);
  // Chat may only be dispatched inside the seam.
  assertEquals(source.split("dispatchChatWakes(").length - 1, 2);
});
