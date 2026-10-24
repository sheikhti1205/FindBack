// Local unit tests for the reply-comment HTTP contract. No network, no Supabase,
// no credential: the RPC is injected as a fake, so the whole request wiring is
// covered without a database.
import { assertEquals } from "jsr:@std/assert";
import {
  handleReply,
  refusalFromRaisedError,
  rpcFailureResponse,
  statusForReason,
  type ReplyDeps,
} from "./index.ts";

const TOKEN = "A".repeat(43);

function post(body: unknown): Request {
  return new Request("https://findback.invalid/reply-comment", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function deps(rpc: ReplyDeps["rpc"]): ReplyDeps {
  return { rpc, hashToken: async () => "hashed" };
}

Deno.test("a probation spacing refusal is a 429, not a server fault", async () => {
  const response = rpcFailureResponse({
    message: "POST_COOLDOWN: wait 24 seconds before posting again",
  });
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "30");
  assertEquals(await response.json(), { ok: false, reason: "rate_limited" });
});

Deno.test("the daily ceiling is the same 429 without a bogus retry-after", async () => {
  const response = rpcFailureResponse({
    message: "POST_LIMIT_REACHED: you have reached today's limit of 3",
  });
  assertEquals(response.status, 429);
  // A day's ceiling is not a 30 s wait; telling the user to retry in 30 s would
  // be a lie and would invite a retry that cannot succeed.
  assertEquals(response.headers.get("retry-after"), null);
  assertEquals(await response.json(), { ok: false, reason: "daily_limit" });
});

Deno.test("a zero-limit standing refusal is a 403, not a quota and not a wait", async () => {
  const response = rpcFailureResponse({
    message: "POST_NOT_AVAILABLE: your account cannot post or comment right now",
  });
  // This shared POST_LIMIT_REACHED until R3 F-1, which made the device copy
  // ("that's all your replies for today") false for a restricted account.
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("retry-after"), null);
  assertEquals(await response.json(), { ok: false, reason: "account_restricted" });
});

Deno.test("an unexpected RPC error stays a 500 and leaks nothing", async () => {
  const response = rpcFailureResponse({
    message: 'duplicate key value violates unique constraint "push_reply_tokens_pkey"',
  });
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "reply failed" });
});

Deno.test("a null error object cannot masquerade as a rate limit", async () => {
  assertEquals(rpcFailureResponse(null).status, 500);
});

Deno.test("only the guard words classify as refusals", () => {
  assertEquals(refusalFromRaisedError("POST_COOLDOWN: wait 5 seconds")?.reason, "rate_limited");
  assertEquals(refusalFromRaisedError("POST_LIMIT_REACHED: today's limit")?.reason, "daily_limit");
  assertEquals(
    refusalFromRaisedError("POST_NOT_AVAILABLE: your account cannot post")?.reason,
    "account_restricted",
  );
  assertEquals(refusalFromRaisedError("permission denied for table reactions"), null);
  assertEquals(refusalFromRaisedError("")?.reason, undefined);
});

Deno.test("reason to status mapping stays stable", () => {
  assertEquals(statusForReason("used"), 409);
  assertEquals(statusForReason("parent_unavailable"), 409);
  assertEquals(statusForReason("invalid_body"), 422);
  assertEquals(statusForReason("depth_exceeded"), 422);
  assertEquals(statusForReason("rate_limited"), 429);
  assertEquals(statusForReason("daily_limit"), 429);
  assertEquals(statusForReason("account_restricted"), 403);
  assertEquals(statusForReason("missing"), 403);
});

Deno.test("a refused reply reaches the device as 429 through the real handler", async () => {
  const response = await handleReply(
    post({ token: TOKEN, body: "silver zipper" }),
    deps(async () => ({
      data: null,
      error: { message: "POST_COOLDOWN: wait 24 seconds before posting again" },
    })),
  );
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "30");
  assertEquals(await response.json(), { ok: false, reason: "rate_limited" });
});

Deno.test("the day's ceiling also reaches the device as 429", async () => {
  const response = await handleReply(
    post({ token: TOKEN, body: "silver zipper" }),
    deps(async () => ({
      data: null,
      error: { message: "POST_LIMIT_REACHED: you have reached today's limit of 3" },
    })),
  );
  assertEquals(response.status, 429);
  assertEquals(await response.json(), { ok: false, reason: "daily_limit" });
});

Deno.test("a consumed token answered by the RPC is a 409", async () => {
  const response = await handleReply(
    post({ token: TOKEN, body: "silver zipper" }),
    deps(async () => ({ data: [{ ok: false, reason: "used" }], error: null })),
  );
  assertEquals(response.status, 409);
  assertEquals(await response.json(), { error: "used" });
});

Deno.test("an accepted reply returns the comment id", async () => {
  const response = await handleReply(
    post({ token: TOKEN, body: "silver zipper" }),
    deps(async () => ({ data: [{ ok: true, comment_id: "c-1" }], error: null })),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, commentId: "c-1" });
});

Deno.test("the RPC is called with the hashed token and the trimmed body", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await handleReply(
    post({ token: TOKEN, body: "  silver zipper  " }),
    deps(async (name, args) => {
      calls.push({ name, args });
      return { data: [{ ok: true, comment_id: "c-2" }], error: null };
    }),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "findback_consume_reply_token_and_add_comment");
  assertEquals(calls[0].args, { p_token_hash: "hashed", p_body: "silver zipper" });
});

Deno.test("malformed input never reaches the RPC", async () => {
  let reached = false;
  const spy = deps(async () => {
    reached = true;
    return { data: null, error: null };
  });
  assertEquals((await handleReply(post({ token: "short", body: "hi" }), spy)).status, 400);
  assertEquals((await handleReply(post({ token: TOKEN, body: "   " }), spy)).status, 422);
  assertEquals((await handleReply(post({ token: TOKEN }), spy)).status, 422);
  assertEquals(
    (await handleReply(new Request("https://findback.invalid/x", { method: "GET" }), spy)).status,
    405,
  );
  assertEquals(reached, false);
});
