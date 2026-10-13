/**
 * cleanup-comment-media unit tests. Run with `deno test supabase/functions/cleanup-comment-media/`.
 * Pure orchestration only: fake queue + fake storage record calls, no
 * network, no secrets.
 *
 * Contract under test (SQL is authoritative — see
 * supabase/migrations/20261013020000_comment_media_cleanup_lease.sql; the
 * MemoryLeaseQueue below mirrors that contract so the consumer tests prove
 * the "never lost" property end to end):
 *   - claim MARKS rows leased (leased_at + attempts++) and never deletes;
 *   - ack DELETES only the keys passed after Storage success;
 *   - leases older than STALE_LEASE_MINUTES are reclaimable;
 *   - Storage failure leaves the key queued (never acked, never lost);
 *   - one bad key never kills its batch (per-key isolation);
 *   - a failed ack half-acks nothing (throw; keys stay leased).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  CLAIM_BATCH_SIZE,
  CLEANUP_BUCKET,
  handleCleanup,
  MAX_BATCHES_PER_INVOCATION,
  STALE_LEASE_MINUTES,
  sweepBatch,
  type CleanupClients,
  type CleanupStorageAdmin,
  type QueueAdmin,
} from "./index.ts";

interface QueueRow {
  key: string;
  leasedAt: number | null;
  attempts: number;
}

const STALE_MS = STALE_LEASE_MINUTES * 60 * 1000;

/** In-memory mirror of the SQL lease/ack contract (claim marks, ack deletes). */
class MemoryLeaseQueue implements QueueAdmin {
  readonly rows = new Map<string, QueueRow>();
  readonly calls: string[] = [];
  failClaim: string | null = null;
  failAck: string | null = null;
  now: number;

  constructor(keys: string[] = [], now = Date.now()) {
    this.now = now;
    for (const key of keys) this.rows.set(key, { key, leasedAt: null, attempts: 0 });
  }

  /** Test helper: pretend a row was leased `ageMs` ago. */
  leaseAged(key: string, ageMs: number): void {
    const row = this.rows.get(key);
    if (row) {
      row.leasedAt = this.now - ageMs;
      row.attempts += 1;
    }
  }

  async claim(limit: number) {
    this.calls.push(`claim:${limit}`);
    if (this.failClaim) return { keys: null, error: { message: this.failClaim } };
    const batch = [...this.rows.values()]
      .filter((r) => r.leasedAt === null || this.now - r.leasedAt >= STALE_MS)
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
    for (const row of batch) {
      row.leasedAt = this.now;
      row.attempts += 1;
    }
    return { keys: batch.map((r) => r.key), error: null };
  }

  async ack(keys: string[]) {
    this.calls.push(`ack:${keys.join(",")}`);
    if (this.failAck) return { acked: null, error: { message: this.failAck } };
    const acked: string[] = [];
    for (const key of keys) {
      if (this.rows.delete(key)) acked.push(key);
    }
    return { acked, error: null };
  }
}

function fakeStorage(
  calls: string[],
  opts: { failKeys?: Set<string>; failAll?: string; throwKeys?: Set<string> } = {},
): { from(bucket: string): CleanupStorageAdmin } {
  return {
    from(bucket: string): CleanupStorageAdmin {
      return {
        async remove(paths: string[]) {
          calls.push(`remove:${bucket}:${paths.join(",")}`);
          for (const path of paths) {
            if (opts.throwKeys?.has(path)) throw new Error("connection reset");
            if (opts.failAll ?? opts.failKeys?.has(path)) {
              return { error: { message: `missing: ${path}` } };
            }
          }
          return { error: null };
        },
      };
    },
  };
}

function fakeClients(opts: {
  keys?: string[];
  failKeys?: Set<string>;
  failAllRemove?: string;
  throwKeys?: Set<string>;
  failClaim?: string;
  failAck?: string;
} = {}): { clients: CleanupClients; queue: MemoryLeaseQueue; calls: string[] } {
  const calls: string[] = [];
  const queue = new MemoryLeaseQueue(opts.keys ?? []);
  if (opts.failClaim) queue.failClaim = opts.failClaim;
  if (opts.failAck) queue.failAck = opts.failAck;
  const storage = fakeStorage(calls, {
    failKeys: opts.failKeys,
    failAll: opts.failAllRemove,
    throwKeys: opts.throwKeys,
  });
  const clients: CleanupClients = { queue, storage };
  const origClaim = queue.claim.bind(queue);
  const origAck = queue.ack.bind(queue);
  clients.queue = {
    claim: async (limit: number) => {
      calls.push(`claim:${limit}`);
      return origClaim(limit);
    },
    ack: async (keys: string[]) => {
      calls.push(`ack:${keys.join(",")}`);
      return origAck(keys);
    },
  };
  return { clients, queue, calls };
}

const ENV = { serviceRoleKey: "svc-key", cronSecret: "cron-secret" };

Deno.test("full sweep drains the queue with one attempt per task", async () => {
  const { clients, queue } = fakeClients({ keys: ["u1/a.jpg", "u1/b.jpg"] });
  const batch = await sweepBatch(clients, 10);
  assertEquals(batch.claimed, 2);
  assertEquals(batch.acked, ["u1/a.jpg", "u1/b.jpg"]);
  assertEquals(queue.rows.size, 0, "acked successes drain; failures would stay");
});

Deno.test("claim alone marks-not-deletes (queue rows survive the claim)", async () => {
  const { queue } = fakeClients({ keys: ["u1/a.jpg"] });
  const { keys, error } = await queue.claim(10);
  assertEquals(error, null);
  assertEquals(keys, ["u1/a.jpg"]);
  assert(queue.rows.has("u1/a.jpg"), "claimed row must survive until ack");
  const row = queue.rows.get("u1/a.jpg")!;
  assert(row.leasedAt !== null, "claimed row is marked leased");
  assertEquals(row.attempts, 1, "claim increments attempts");
});

Deno.test("ack deletes only the acked keys", async () => {
  const { queue } = fakeClients({ keys: ["u1/a.jpg", "u1/b.jpg"] });
  await queue.claim(10);
  const { acked, error } = await queue.ack(["u1/a.jpg"]);
  assertEquals(error, null);
  assertEquals(acked, ["u1/a.jpg"]);
  assert(!queue.rows.has("u1/a.jpg"), "acked row deleted");
  assert(queue.rows.has("u1/b.jpg"), "unacked row survives");
});

Deno.test("stale leases are reclaimable after the window", async () => {
  const { queue } = fakeClients({ keys: ["u1/stale.jpg", "u1/fresh.jpg"] });
  await queue.claim(10);
  // Fresh lease is invisible to the next claim …
  assertEquals((await queue.claim(10)).keys, []);
  // … but a lease older than the window is reclaimable.
  queue.leaseAged("u1/stale.jpg", (STALE_LEASE_MINUTES + 1) * 60 * 1000);
  const { keys } = await queue.claim(10);
  assertEquals(keys, ["u1/stale.jpg"]);
  assertEquals(queue.rows.get("u1/stale.jpg")!.attempts, 3);
});

Deno.test("success path: claim, per-key remove, ack of exactly the removed keys", async () => {
  const { clients, calls, queue } = fakeClients({ keys: ["u1/a.jpg", "u1/b.jpg"] });
  const res = await handleCleanup(clients, "Bearer svc-key", null, ENV);
  assertEquals(res.status, 200);
  assertEquals(res.body, {
    claimed: 2,
    removed: 2,
    acked: 2,
    failedKeys: [],
    batches: 1,
    complete: true,
  });
  assertEquals(queue.rows.size, 0);
  assertEquals(calls, [
    "claim:100",
    `remove:${CLEANUP_BUCKET}:u1/a.jpg`,
    `remove:${CLEANUP_BUCKET}:u1/b.jpg`,
    "ack:u1/a.jpg,u1/b.jpg",
    "claim:100",
  ]);
});

Deno.test("Storage failure stays queued: failed key never acked, never lost", async () => {
  const { clients, queue } = fakeClients({
    keys: ["u1/good.jpg", "u1/gone.jpg"],
    failKeys: new Set(["u1/gone.jpg"]),
  });
  const res = await handleCleanup(clients, null, "cron-secret", ENV);
  assertEquals(res.status, 200);
  assertEquals(res.body.claimed, 2);
  assertEquals(res.body.removed, 1);
  assertEquals(res.body.acked, 1);
  assertEquals(res.body.failedKeys, ["u1/gone.jpg"]);
  assert(!queue.rows.has("u1/good.jpg"), "success acked away");
  assert(queue.rows.has("u1/gone.jpg"), "failure stays queued for the next sweep");
  const row = queue.rows.get("u1/gone.jpg")!;
  assertEquals(row.attempts, 1, "claim counted the attempt; the task is not lost");
});

Deno.test("bad-key isolation: one bad key does not kill its batch", async () => {
  const { clients, queue } = fakeClients({
    keys: ["u1/a.jpg", "u1/bad.jpg", "u1/c.jpg"],
    failKeys: new Set(["u1/bad.jpg"]),
  });
  const batch = await sweepBatch(clients, 10);
  assertEquals(batch.claimed, 3);
  assertEquals(batch.removed, ["u1/a.jpg", "u1/c.jpg"]);
  assertEquals(batch.failed, ["u1/bad.jpg"]);
  assertEquals(batch.acked, ["u1/a.jpg", "u1/c.jpg"]);
  assertEquals(queue.rows.size, 1);
  assert(queue.rows.has("u1/bad.jpg"));
});

Deno.test("thrown storage errors are isolated per key, not per batch", async () => {
  const { clients, queue } = fakeClients({
    keys: ["u1/a.jpg", "u1/flaky.jpg"],
    throwKeys: new Set(["u1/flaky.jpg"]),
  });
  const batch = await sweepBatch(clients, 10);
  assertEquals(batch.removed, ["u1/a.jpg"]);
  assertEquals(batch.failed, ["u1/flaky.jpg"]);
  assertEquals(batch.acked, ["u1/a.jpg"]);
  assert(queue.rows.has("u1/flaky.jpg"), "thrown failure still queued");
});

Deno.test("failed ack half-acks nothing: successes stay leased for reclaim", async () => {
  const { clients, queue } = fakeClients({
    keys: ["u1/a.jpg", "u1/b.jpg"],
    failAck: "db down",
  });
  let message = "";
  try {
    await sweepBatch(clients, 10);
  } catch (err) {
    message = err instanceof Error ? err.message : "";
  }
  assertEquals(message, "ack failed: db down");
  assertEquals(queue.rows.size, 2, "nothing acked away on ack failure");
  for (const key of ["u1/a.jpg", "u1/b.jpg"]) {
    assert(queue.rows.get(key)!.leasedAt !== null, `${key} stays leased, reclaimable after the window`);
  }
});

Deno.test("anon/authenticated-style callers run zero queue/storage calls", async () => {
  // No credentials at all.
  {
    const { clients, calls } = fakeClients({ keys: ["u1/a.jpg"] });
    const res = await handleCleanup(clients, null, null, ENV);
    assertEquals(res.status, 401);
    assertEquals(calls, []);
  }
  // Wrong secret.
  {
    const { clients, calls } = fakeClients({ keys: ["u1/a.jpg"] });
    const res = await handleCleanup(clients, null, "wrong", ENV);
    assertEquals(res.status, 401);
    assertEquals(calls, []);
  }
  // A user JWT is just a bearer that is not the service key: rejected.
  {
    const { clients, calls } = fakeClients({ keys: ["u1/a.jpg"] });
    const res = await handleCleanup(clients, "Bearer eyJhbGciOiJIUzI1NiJ9.user.jwt", null, ENV);
    assertEquals(res.status, 401);
    assertEquals(calls, []);
  }
});

Deno.test("empty claim completes without touching storage or ack", async () => {
  const { clients, calls } = fakeClients({ keys: [] });
  const res = await handleCleanup(clients, "Bearer svc-key", null, ENV);
  assertEquals(res.status, 200);
  assertEquals(res.body.complete, true);
  assertEquals(res.body.batches, 0);
  assert(calls.every((c) => c.startsWith("claim:")), `only claims ran: ${calls.join(",")}`);
  assert(!calls.some((c) => c.startsWith("remove:") || c.startsWith("ack:")), calls.join(","));
});

Deno.test("claim failure aborts with 502 before storage or ack", async () => {
  const { clients, calls } = fakeClients({ keys: ["u1/a.jpg"], failClaim: "db down" });
  const res = await handleCleanup(clients, "Bearer svc-key", null, ENV);
  assertEquals(res.status, 502);
  assertEquals(res.body.error, "claim failed: db down");
  assert(!calls.some((c) => c.startsWith("remove:") || c.startsWith("ack:")), calls.join(","));
});

Deno.test("batch cap and invocation bound: claim limit capped, loop bounded", async () => {
  assert(CLAIM_BATCH_SIZE <= 1000, "claim batch fits the SQL clamp");
  const many = Array.from({ length: 250 }, (_, i) => `u1/p${i}.jpg`);
  const { clients, calls } = fakeClients({ keys: many });
  const res = await handleCleanup(clients, "Bearer svc-key", null, ENV, { maxBatches: 2 });
  assertEquals(res.status, 200);
  assertEquals(res.body.batches, 2);
  assertEquals(res.body.claimed, 2 * CLAIM_BATCH_SIZE);
  const claimLimits = calls.filter((c) => c.startsWith("claim:")).map((c) => Number(c.slice("claim:".length)));
  assert(claimLimits.every((n) => n === CLAIM_BATCH_SIZE), `claim limits: ${claimLimits.join(",")}`);
  // Default bound still applies without options.
  assertEquals(MAX_BATCHES_PER_INVOCATION, 10);
});

Deno.test("response carries counts and keys only — never user content", async () => {
  const { clients } = fakeClients({ keys: ["u1/a.jpg"], failKeys: new Set(["u1/a.jpg"]) });
  const res = await handleCleanup(clients, "Bearer svc-key", null, ENV);
  const body = JSON.stringify(res.body);
  assert(!body.includes("comment"), "response must not echo comment content");
  assertEquals(Object.keys(res.body).sort(), ["acked", "batches", "claimed", "complete", "failedKeys", "removed"]);
});
