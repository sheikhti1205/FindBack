/**
 * cleanup-report-media — Supabase Edge Function (report-photo sweep).
 *
 * P11. Report photos moved to the private `findback-report-media` bucket and
 * deleting a report (or its account) cascades the attachment rows, never the
 * Storage bytes. Two producers feed `public.report_media_cleanup_queue`:
 *   - the `attachments_report_media_cleanup` AFTER DELETE trigger;
 *   - `findback_discard_staged_upload` (editor discards a staged photo).
 * This worker drains that queue and also purges abandoned staged uploads whose
 * 24h grace period has passed, so an abandoned editor run cannot accumulate
 * bytes forever.
 *
 * Claim/ack lease semantics (supabase/migrations/20261102120000_…):
 *   - `claim_report_media_cleanup(p_limit)` marks a bounded batch leased
 *     (`leased_at = now()`, `attempts + 1`, only unleased or stale-leased rows)
 *     and returns it — it never deletes, so a crash between claim and Storage
 *     removal loses nothing;
 *   - `ack_report_media_cleanup(p_bucket_id, p_keys)` deletes only the keys
 *     passed after Storage success;
 *   - leases older than STALE_LEASE_MINUTES (15) are reclaimable.
 *
 * Authorization (service-role/internal only, never anon/authenticated): the
 * caller must present EITHER `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
 * OR `x-cleanup-secret: <CLEANUP_CRON_SECRET>`. Ordinary user JWTs match
 * neither and get 401 with zero queue/storage calls. Logs and responses carry
 * storage keys and counts only, never report content.
 *
 * Required function environment (set with `supabase secrets set`):
 * - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — injected by the runtime.
 * - `CLEANUP_CRON_SECRET` (optional) — shared secret for the scheduler.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

/** Bucket holding report photos (sweep target, never listed wholesale). */
export const CLEANUP_BUCKET = "findback-report-media";

/** Keys claimed per batch (fits the SQL clamp of 1..1000). */
export const CLAIM_BATCH_SIZE = 100;

/** Batches per invocation (timeout bound: finish started batches, then stop). */
export const MAX_BATCHES_PER_INVOCATION = 10;

/**
 * Stale-lease window in minutes. Mirrors the SQL cutoff
 * (`leased_at < now() - interval '15 minutes'`): a lease older than this is
 * reclaimable by the next claim.
 */
export const STALE_LEASE_MINUTES = 15;

export interface QueueAdmin {
  claim(limit: number): Promise<{
    keys: string[] | null;
    error: { message: string } | null;
  }>;
  ack(keys: string[]): Promise<{
    acked: number | null;
    error: { message: string } | null;
  }>;
}

export interface CleanupStorageAdmin {
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

export interface CleanupClients {
  queue: QueueAdmin;
  storage: { from(bucket: string): CleanupStorageAdmin };
  /** Returns how many abandoned staging rows were purged (0 when disabled). */
  purgeStaging?: () => Promise<{ purged: number; error: { message: string } | null }>;
}

export interface CleanupEnv {
  serviceRoleKey: string;
  cronSecret: string;
}

export interface BatchResult {
  claimed: number;
  removed: string[];
  failed: string[];
  acked: number;
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
 * Internal-only gate: true when the caller proves scheduler identity via the
 * service-role key or the cron secret. User JWTs match neither and are rejected.
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
 * One lease batch: claim, remove each key in isolation, ack exactly the removed
 * keys. Throws `claim failed: …` before touching Storage, or `ack failed: …`
 * with nothing half-acked (successes stay leased and are reclaimed stale).
 */
export async function sweepBatch(clients: CleanupClients, limit: number): Promise<BatchResult> {
  const claimed = await clients.queue.claim(limit);
  if (claimed.error) throw new Error(`claim failed: ${claimed.error.message}`);
  const keys = claimed.keys ?? [];
  if (keys.length === 0) return { claimed: 0, removed: [], failed: [], acked: 0 };
  const bucket = clients.storage.from(CLEANUP_BUCKET);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      const { error } = await bucket.remove([key]);
      if (error) {
        console.warn(`cleanup-report-media: storage remove failed for key: ${key}`);
        failed.push(key);
      } else {
        removed.push(key);
      }
    } catch {
      console.warn(`cleanup-report-media: storage remove threw for key: ${key}`);
      failed.push(key);
    }
  }
  let acked = 0;
  if (removed.length > 0) {
    const ack = await clients.queue.ack(removed);
    if (ack.error) throw new Error(`ack failed: ${ack.error.message}`);
    acked = ack.acked ?? 0;
  }
  return { claimed: keys.length, removed, failed, acked };
}

/**
 * Full orchestration: gate, purge abandoned staging, then bounded
 * claim/remove/ack batches. Every branch returns an explicit status + body
 * carrying counts and storage keys only (never report content).
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
  let purgedStaging = 0;
  if (clients.purgeStaging) {
    // A failure here must not stop the byte sweep: queued objects are the
    // higher-value work. It is reported, never swallowed.
    try {
      const purged = await clients.purgeStaging();
      if (purged.error) {
        console.warn(`cleanup-report-media: staging purge failed: ${purged.error.message}`);
      } else {
        purgedStaging = purged.purged;
      }
    } catch {
      console.warn("cleanup-report-media: staging purge threw");
    }
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
      acked += batch.acked;
      failedKeys.push(...batch.failed);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "cleanup failed";
    return {
      status: 502,
      body: { error: message, purgedStaging, claimed, removed, acked, failedKeys, batches, complete: false },
    };
  }
  console.log(
    `cleanup-report-media: purgedStaging=${purgedStaging} batches=${batches} claimed=${claimed} removed=${removed} acked=${acked} failed=${failedKeys.length}`,
  );
  return {
    status: 200,
    body: { purgedStaging, claimed, removed, acked, failedKeys, batches, complete: true },
  };
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
          const { data, error } = await supabase.rpc("claim_report_media_cleanup", { p_limit: limit });
          if (error) return { keys: null, error: { message: error.message } };
          const rows = (data ?? []) as { bucket_id: string; object_key: string }[];
          // One bucket today; a row pointing elsewhere is skipped rather than
          // removed from the wrong place.
          return {
            keys: rows.filter((r) => r.bucket_id === CLEANUP_BUCKET).map((r) => r.object_key),
            error: null,
          };
        },
        ack: async (keys: string[]) => {
          const { data, error } = await supabase.rpc("ack_report_media_cleanup", {
            p_bucket_id: CLEANUP_BUCKET,
            p_keys: keys,
          });
          if (error) return { acked: null, error: { message: error.message } };
          return { acked: typeof data === "number" ? data : null, error: null };
        },
      },
      storage: {
        from: (bucket: string) => supabase.storage.from(bucket) as unknown as CleanupStorageAdmin,
      },
      purgeStaging: async () => {
        const { data, error } = await supabase.rpc("purge_abandoned_staging_uploads", {
          p_limit: 200,
        });
        if (error) return { purged: 0, error: { message: error.message } };
        return { purged: typeof data === "number" ? data : 0, error: null };
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
