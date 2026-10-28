import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { sweepChatMediaCleanup, type CleanupCandidate, type CleanupCursor, type CleanupPorts } from "./chatMediaCleanup.ts";

const uuid = (n: number) => `00000000-0000-4000-9854-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-10-28T00:00:00Z");
function candidate(n = 1): CleanupCandidate {
  return { bucket: "findback-chat-media", mediaId: uuid(n), generation: uuid(n + 10), objectKey: `attachments/${uuid(n + 20)}` };
}
function row(n = 1) {
  return candidate(n);
}
class MemoryCleanup implements CleanupPorts {
  batches: unknown[][] = [[row()]];
  objects = new Set<string>([candidate().objectKey]);
  events: string[] = [];
  removed: CleanupCandidate[] = [];
  confirmed: CleanupCandidate[] = [];
  rechecked: CleanupCandidate[] = [];
  /** Object keys that must reappear after the first removal. */
  lateWrite = new Set<string>();
  cursors: Array<string | null> = [];
  async claim(limit: number, after: CleanupCursor | null, signal: AbortSignal) {
    signal.throwIfAborted();
    this.cursors.push(after ? after.objectKey : null);
    this.events.push(`claim:${limit}`);
    return this.batches.shift() ?? [];
  }
  async remove(value: CleanupCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push(`remove:${value.objectKey}`);
    this.objects.delete(value.objectKey);
    this.removed.push(value);
  }
  async exists(value: CleanupCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push(`exists:${value.objectKey}`);
    // A late write lands only once, right after the first removal.
    if (!this.objects.has(value.objectKey) && this.lateWrite.delete(value.objectKey)) {
      this.objects.add(value.objectKey);
    }
    return this.objects.has(value.objectKey);
  }
  /** Set false to model a declined acknowledgement (lost lock / blocked source). */
  acknowledge = true;
  async confirm(value: CleanupCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push("confirm");
    if (!this.acknowledge) return false;
    this.confirmed.push(value);
    return true;
  }
  async recheck(value: CleanupCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    this.events.push("recheck");
    this.rechecked.push(value);
  }
}

Deno.test("no due work performs no Storage operation", async () => {
  const io = new MemoryCleanup(); io.batches = [[]];
  equal(await sweepChatMediaCleanup(io, { now: () => start }), {
    status: "idle", claimed: 0, removed: 0, confirmed: 0, deferred: 0, requeued: 0, batches: 0, more: false,
  });
  equal(io.events, ["claim:100"]);
});

Deno.test("verified absence is acknowledged after removal", async () => {
  const io = new MemoryCleanup();
  equal(await sweepChatMediaCleanup(io, { now: () => start }), {
    status: "ok", claimed: 1, removed: 1, confirmed: 1, deferred: 0, requeued: 0, batches: 1, more: false,
  });
  equal(io.events, [`claim:100`, `remove:${candidate().objectKey}`, `exists:${candidate().objectKey}`,
    "confirm", `exists:${candidate().objectKey}`, "claim:100"]);
  equal(io.removed.length, 1);
});

Deno.test("bytes still present after the first removal are removed once more", async () => {
  const io = new MemoryCleanup(); io.lateWrite.add(candidate().objectKey);
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "ok"); equal(result.confirmed, 1); equal(result.deferred, 0);
  equal(io.removed.length, 2);
});

Deno.test("persistently present bytes are never acknowledged", async () => {
  const io = new MemoryCleanup();
  io.remove = async (value: CleanupCandidate, signal: AbortSignal) => {
    signal.throwIfAborted(); io.removed.push(value);
  };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "partial"); equal(result.confirmed, 0); equal(result.deferred, 1);
  equal(io.confirmed, []); ok(!io.events.includes("confirm"));
});

Deno.test("a removal failure is isolated and leaves the row for the next sweep", async () => {
  const io = new MemoryCleanup(); io.batches = [[row(1), row(2)]];
  io.remove = async (value: CleanupCandidate, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (value.mediaId === uuid(1)) throw new Error("storage down");
    io.objects.delete(value.objectKey);
  };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "partial"); equal(result.claimed, 2); equal(result.confirmed, 1); equal(result.deferred, 1);
});

Deno.test("an ambiguous existence check defers instead of assuming deletion", async () => {
  const io = new MemoryCleanup();
  io.exists = async () => { throw new Error("400 invalid path"); };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "partial"); equal(result.deferred, 1); equal(io.confirmed, []);
});

Deno.test("a failed acknowledgement is retried rather than reported removed", async () => {
  const io = new MemoryCleanup();
  io.confirm = async () => { throw new Error("finish unavailable"); };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "partial"); equal(result.confirmed, 0); equal(result.deferred, 1);
});

Deno.test("bytes landing after acknowledgement re-arm the tombstone", async () => {
  const io = new MemoryCleanup();
  io.exists = async (value: CleanupCandidate) => {
    // absent before confirm, present immediately after it
    return io.confirmed.some((c) => c.objectKey === value.objectKey);
  };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "ok"); equal(result.confirmed, 1); equal(result.requeued, 1);
  equal(io.rechecked.length, 1);
});

Deno.test("a lost re-arm never fails the sweep", async () => {
  const io = new MemoryCleanup();
  io.exists = async (value: CleanupCandidate) => io.confirmed.some((c) => c.objectKey === value.objectKey);
  io.recheck = async () => { throw new Error("rpc down"); };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "ok"); equal(result.confirmed, 1); equal(result.requeued, 0);
});

for (const bad of [
  { ...row(), bucket: "public" },
  { ...row(), bucket: "findback-chat-moderation-evidence" },
  { ...row(), mediaId: "not-a-uuid" },
  { ...row(), objectKey: "evidence/00000000-0000-4000-9854-000000000021" },
  { ...row(), objectKey: "attachments/../escape" },
  { ...row(), objectKey: `attachments/${uuid(21)}/extra` },
]) {
  Deno.test(`malformed cleanup row fails closed: ${JSON.stringify(bad)}`, async () => {
    const io = new MemoryCleanup(); io.batches = [[bad]];
    const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
    equal(result.status, "partial"); equal(result.deferred, 1); equal(io.removed, []);
    ok(!io.events.some((event) => event.startsWith("remove:")));
  });
}

Deno.test("evidence candidates address only the evidence namespace", async () => {
  const io = new MemoryCleanup();
  const key = `evidence/${uuid(31)}`;
  io.batches = [[{ bucket: "findback-chat-moderation-evidence", mediaId: uuid(32), generation: uuid(33), objectKey: key }]];
  io.objects = new Set([key]);
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "ok"); equal(io.removed[0].bucket, "findback-chat-moderation-evidence");
  equal(io.removed[0].objectKey, key);
});

Deno.test("batches are bounded by the caller and by the SQL clamp", async () => {
  const io = new MemoryCleanup(); io.batches = [[]];
  await sweepChatMediaCleanup(io, { now: () => start, batchSize: 500 });
  equal(io.events, ["claim:100"]);
  const io2 = new MemoryCleanup(); io2.batches = [[]];
  await sweepChatMediaCleanup(io2, { now: () => start, batchSize: 7 });
  equal(io2.events, ["claim:7"]);
});

Deno.test("multiple batches drain until an empty claim", async () => {
  const io = new MemoryCleanup(); io.batches = [[row(1)], [row(2)], []];
  io.objects = new Set([candidate(1).objectKey, candidate(2).objectKey]);
  const result = await sweepChatMediaCleanup(io, { now: () => start, batchSize: 1, settleMs: 0 });
  // Two non-empty batches plus the empty claim that proves the queue drained.
  equal(result.status, "ok"); equal(result.batches, 2); equal(result.confirmed, 2); equal(result.more, false);
});

Deno.test("abort before claim does not discover work", async () => {
  const io = new MemoryCleanup(); const c = new AbortController(); c.abort();
  const result = await sweepChatMediaCleanup(io, { now: () => start, signal: c.signal });
  equal(result.status, "retry"); equal(io.events, []); equal(result.claimed, 0);
});

Deno.test("cancellation interrupts a hanging port without acknowledging", async () => {
  const io = new MemoryCleanup(); const c = new AbortController();
  io.remove = async () => { c.abort(); return await new Promise(() => {}); };
  const result = await sweepChatMediaCleanup(io, { now: () => start, signal: c.signal, settleMs: 0 });
  equal(result.status, "retry"); equal(io.confirmed, []);
});

Deno.test("deadline exhaustion stops before another claim and never acknowledges unverified work", async () => {
  const io = new MemoryCleanup(); let now = start;
  io.remove = async (value: CleanupCandidate, signal: AbortSignal) => {
    signal.throwIfAborted(); now += 200_000; io.objects.delete(value.objectKey);
  };
  const result = await sweepChatMediaCleanup(io, { now: () => now, settleMs: 0 });
  equal(result.status, "retry"); equal(io.confirmed, []);
});

Deno.test("results never carry object keys, generations or raw errors", async () => {
  const io = new MemoryCleanup(); io.batches = [[row(1), row(2)]];
  io.remove = async () => { throw new Error(JSON.stringify(row())); };
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  const text = JSON.stringify(result);
  ok(!text.includes(candidate().objectKey) && !text.includes(candidate().mediaId) && !text.includes("storage"));
  equal(Object.keys(result).sort(), ["batches", "claimed", "confirmed", "deferred", "more", "removed", "requeued", "status"]);
});

Deno.test("a declined acknowledgement is deferred, never counted as confirmed", async () => {
  const io = new MemoryCleanup();
  io.acknowledge = false;
  const result = await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 });
  equal(result.status, "partial");
  equal(result.removed, 1);
  equal(result.confirmed, 0);
  equal(result.deferred, 1);
  equal(io.confirmed, []);
});

Deno.test("the claim cursor advances so an undeletable row cannot starve the sweep", async () => {
  const io = new MemoryCleanup();
  // Two batches: the first row can never be removed, the second must still be reached.
  io.batches = [[row(1)], [row(2)], []];
  io.objects = new Set([candidate(2).objectKey]);
  io.remove = async (value: CleanupCandidate, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (value.mediaId === uuid(1)) throw new Error("permanent storage error");
    io.objects.delete(value.objectKey);
  };
  const result = await sweepChatMediaCleanup(io, { now: () => start, batchSize: 1, settleMs: 0 });
  equal(result.claimed, 2);
  equal(result.confirmed, 1);
  equal(result.deferred, 1);
  equal(io.cursors, [null, candidate(1).objectKey, candidate(2).objectKey]);
});

Deno.test("an unparseable row still advances the cursor", async () => {
  const io = new MemoryCleanup();
  // The first row can never be parsed, so it can never be removed. It must still
  // move the keyset position or it would be re-claimed in every batch.
  io.batches = [[{ bucket: "findback-chat-media", mediaId: "bad", generation: "bad", objectKey: "not-a-uuid" }], [row(2)], []];
  io.objects = new Set([candidate(2).objectKey]);
  const result = await sweepChatMediaCleanup(io, { now: () => start, batchSize: 1, settleMs: 0 });
  equal(result.claimed, 1);
  equal(result.deferred, 1);
  equal(result.confirmed, 1);
  equal(io.cursors, [null, "not-a-uuid", candidate(2).objectKey]);
});

Deno.test("a partial sweep logs counts only, never a key or generation", async () => {
  const io = new MemoryCleanup();
  io.remove = async () => {}; // removal never actually clears the bytes
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try { await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 }); }
  finally { console.error = original; }
  equal(logged.length, 1);
  const payload = JSON.parse(logged[0]) as Record<string, unknown>;
  equal(payload.event, "chat_media_cleanup");
  equal(payload.status, "partial");
  ok(!logged[0].includes(candidate().objectKey));
  ok(!logged[0].includes(candidate().generation));
});

Deno.test("a successful sweep logs nothing", async () => {
  const io = new MemoryCleanup();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try { await sweepChatMediaCleanup(io, { now: () => start, settleMs: 0 }); }
  finally { console.error = original; }
  equal(logged, []);
});
