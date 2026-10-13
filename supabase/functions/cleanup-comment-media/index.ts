/**
 * cleanup-comment-media — Supabase Edge Function (comment-attachment sweep).
 *
 * Drains `public.comment_media_cleanup_queue` (enqueued by the
 * `comment_attachments_cleanup_enqueue` trigger on every attachment delete)
 * and removes the orphaned bytes from the `findback-comment-media` bucket.
 * Claim/ack lease semantics live in
 * supabase/migrations/20261013020000_comment_media_cleanup_lease.sql:
 *   - `claim_comment_media_cleanup(p_limit)` MARKS a bounded batch leased
 *     (`leased_at = now()`, `attempts + 1`, only unleased or stale-leased
 *     rows) and RETURNS it — it never deletes, so a crash between claim
 *     and Storage removal loses nothing;
 *   - `ack_comment_media_cleanup(p_keys)` DELETES only the keys passed
 *     after Storage success;
 *   - leases older than STALE_LEASE_MINUTES (15) are reclaimable, so a
 *     crashed or timed-out invocation retries instead of orphaning.
 *
 * Invocation contract (timeout-safe, loss-free):
 *   loop { claim batch -> per-key Storage remove -> ack successes }.
 *   - Failures stay queued (claimed but unacked rows keep their lease and
 *     are reclaimed stale): a Storage failure never deletes the task.
 *   - Per-item error isolation: each key is removed on its own; one bad
 *     key is recorded in `failedKeys` and the rest of the batch proceeds.
 *   - Never half-ack: ack runs once per batch with exactly the removed
 *     keys; an ack failure throws and the whole batch stays leased.
 *   - Bounded: CLAIM_BATCH_SIZE keys per batch, at most
 *     MAX_BATCHES_PER_INVOCATION batches per invocation; an empty claim
 *     ends the loop as complete.
 *
 * Authorization (service-role/internal only, never anon/authenticated):
 * the caller must present EITHER `Authorization: Bearer
 * <SUPABASE_SERVICE_ROLE_KEY>` OR `x-cleanup-secret: <CLEANUP_CRON_SECRET>`.
 * Ordinary anon/authenticated user JWTs match neither and get 401 with
 * zero queue/storage calls. The function never reads comment bodies —
 * logs and responses carry storage keys and counts only, never user data.
 *
 * Required function environment (set with `supabase secrets set`):
 * - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — injected by the runtime.
 * - `CLEANUP_CRON_SECRET` (optional) — shared secret for the scheduler;
 *   when set, the scheduler calls with `x-cleanup-secret`.
 *
 * Pure orchestration (`sweepBatch`, `handleCleanup`, `isAuthorized`) is
 * dependency-injected for unit tests: `deno test supabase/functions/cleanup-comment-media/`.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

/** Bucket holding comment attachment bytes (sweep target, never listed). */
export const CLEANUP_BUCKET = "findback-comment-media";

/** Keys claimed per batch (fits the SQL clamp of 1..1000). */
export const CLAIM_BATCH_SIZE = 100;

/** Batches per invocation (timeout bound: finish started batches, then stop). */
export const MAX_BATCHES_PER_INVOCATION = 10;

/**
 * Stale-lease window in minutes. Mirrors the SQL cutoff
 * (`leased_at < now() - interval '15 minutes'`): a lease older than this
 * is reclaimable by the next claim. Documented here so the consumer and
 * the migration can never silently disagree (parity test asserts both).
 */
export const STALE_LEASE_MINUTES = 15;

export interface QueueAdmin {
  claim(limit: number): Promise<{
    keys: string[] | null;
    error: { message: string } | null;
  }>;
  ack(keys: string[]): Promise<{
    acked: string[] | null;
    error: { message: string } | null;
  }>;
}

export interface CleanupStorageAdmin {
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

export interface CleanupClients {
  queue: QueueAdmin;
  storage: { from(bucket: string): CleanupStorageAdmin };
}

export interface CleanupEnv {
  serviceRoleKey: string;
  cronSecret: string;
}

export interface BatchResult {
  claimed: number;
  removed: string[];
  failed: string[];
  acked: string[];
}

export interface CleanupResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CleanupOptions {
  maxBatches?: number;
}

/** Extracts the Bearer token; null when absent or malformed (never throws). */
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Internal-only gate: true when the caller proves scheduler identity via
 * the service-role key or the cron secret. User JWTs (anon or
 * authenticated) match neither and are rejected — the function never
 * accepts a user session as authorization.
 */
export function isAuthorized(
  authHeader: string | null,
  cronHeader: string | null,
  env: CleanupEnv,
): boolean {
  if (env.cronSecret !== "" && cronHeader !== null && cronHeader === env.cronSecret) return true;
  const bearer = extractBearer(authHeader);
  if (env.serviceRoleKey !== "" && bearer !== null && bearer === env.serviceRoleKey) return true;
  return false;
}

/**
 * One lease batch: claim, remove each key in isolation, ack exactly the
 * removed keys. Throws `claim failed: …` before touching Storage, or
 * `ack failed: …` with nothing half-acked (successes stay leased and are
 * reclaimed stale). Storage per-key failures are returned in `failed`,
 * never thrown, so one bad key cannot kill its batch.
 */
export async function sweepBatch(clients: CleanupClients, limit: number): Promise<BatchResult> {
  const claimed = await clients.queue.claim(limit);
  if (claimed.error) throw new Error(`claim failed: ${claimed.error.message}`);
  const keys = claimed.keys ?? [];
  if (keys.length === 0) return { claimed: 0, removed: [], failed: [], acked: [] };
  const bucket = clients.storage.from(CLEANUP_BUCKET);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      const { error } = await bucket.remove([key]);
      if (error) {
        console.warn(`cleanup-comment-media: storage remove failed for key: ${key}`);
        failed.push(key);
      } else {
        removed.push(key);
      }
    } catch {
      console.warn(`cleanup-comment-media: storage remove threw for key: ${key}`);
      failed.push(key);
    }
  }
  let acked: string[] = [];
  if (removed.length > 0) {
    const ack = await clients.queue.ack(removed);
    if (ack.error) throw new Error(`ack failed: ${ack.error.message}`);
    acked = ack.acked ?? [];
  }
  return { claimed: keys.length, removed, failed, acked };
}

/**
 * Full orchestration: gate, then bounded claim/remove/ack batches.
 * Every branch returns an explicit status + body carrying counts and
 * storage keys only (never user content). A mid-loop claim/ack failure
 * returns 502 with the progress so far; unacked keys stay leased for the
 * next invocation — tasks are never lost.
 */
export async function handleCleanup(
  clients: CleanupClients,
  authHeader: string | null,
  cronHeader: string | null,
  env: CleanupEnv,
  options: CleanupOptions = {},
): Promise<CleanupResponse> {
  if (!isAuthorized(authHeader, cronHeader, env)) {
    const missing = extractBearer(authHeader) === null && (cronHeader === null || cronHeader === "");
    return { status: 401, body: { error: missing ? "missing credentials" : "invalid credentials" } };
  }
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_INVOCATION;
  let claimed = 0;
  let removed = 0;
  let acked = 0;
  const failedKeys: string[] = [];
  let batches = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const batch = await sweepBatch(clients, CLAIM_BATCH_SIZE);
      if (batch.claimed === 0) break;
      batches += 1;
      claimed += batch.claimed;
      removed += batch.removed.length;
      acked += batch.acked.length;
      failedKeys.push(...batch.failed);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "cleanup failed";
    return { status: 502, body: { error: message, claimed, removed, acked, failedKeys, batches, complete: false } };
  }
  console.log(
    `cleanup-comment-media: batches=${batches} claimed=${claimed} removed=${removed} acked=${acked} failed=${failedKeys.length}`,
  );
  return { status: 200, body: { claimed, removed, acked, failedKeys, batches, complete: true } };
}

function jsonResponse(response: CleanupResponse): Response {
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

if (import.meta.main) {
  serve(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      });
    }
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: "server misconfigured" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const cronSecret = Deno.env.get("CLEANUP_CRON_SECRET") ?? "";
    const supabase = createClient(url, serviceKey);
    const clients: CleanupClients = {
      queue: {
        claim: async (limit: number) => {
          const { data, error } = await supabase.rpc("claim_comment_media_cleanup", { p_limit: limit });
          if (error) return { keys: null, error: { message: error.message } };
          const rows = (data ?? []) as { storage_key: string }[];
          return { keys: rows.map((r) => r.storage_key), error: null };
        },
        ack: async (keys: string[]) => {
          const { data, error } = await supabase.rpc("ack_comment_media_cleanup", { p_keys: keys });
          if (error) return { acked: null, error: { message: error.message } };
          const rows = (data ?? []) as { storage_key: string }[];
          return { acked: rows.map((r) => r.storage_key), error: null };
        },
      },
      storage: {
        from: (bucket: string) => supabase.storage.from(bucket) as unknown as CleanupStorageAdmin,
      },
    };
    return jsonResponse(
      await handleCleanup(
        clients,
        req.headers.get("authorization"),
        req.headers.get("x-cleanup-secret"),
        { serviceRoleKey: serviceKey, cronSecret },
      ),
    );
  });
}
