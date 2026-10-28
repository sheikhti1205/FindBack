/** Storage-API-first chat media cleanup. Deletion is acknowledged only after
 * absence is verified twice, and a bounded tombstone keeps re-checking for a
 * late write that lands after the acknowledgement. No listing, signed URL,
 * metadata edit, or direct storage.objects delete lives here. */
export type CleanupBucket = "findback-chat-media" | "findback-chat-moderation-evidence";

export interface CleanupCandidate {
  bucket: CleanupBucket;
  mediaId: string;
  generation: string;
  objectKey: string;
}

/** The keyset position of the last row claimed in this sweep. It is text-only
 * and is never used to address Storage, so a row that cannot be removed still
 * advances the sweep instead of starving everything ordered after it. */
export interface CleanupCursor { bucket: string; objectKey: string }

export interface CleanupPorts {
  /** Returns the canonical candidate rows; an empty array means no due work.
   * `after` is the last (bucket, key) already claimed in this sweep, so a row
   * that can never be removed cannot be re-claimed ahead of the rest. */
  claim(limit: number, after: CleanupCursor | null, signal: AbortSignal): Promise<unknown>;
  /** Idempotent removal of exactly this immutable object generation. */
  remove(candidate: CleanupCandidate, signal: AbortSignal): Promise<void>;
  /** Must throw on permission/proxy/malformed failures; only real 404 is false. */
  exists(candidate: CleanupCandidate, signal: AbortSignal): Promise<boolean>;
  /** findback_chat_media_cleanup_done, after absence was verified. Resolves
   * true only when the database actually advanced or purged the row; a
   * declined acknowledgement (lost lock, blocked source) is not success. */
  confirm(candidate: CleanupCandidate, signal: AbortSignal): Promise<boolean>;
  /** findback_chat_media_cleanup_recheck, when bytes reappear after confirmation. */
  recheck(candidate: CleanupCandidate, signal: AbortSignal): Promise<void>;
}

export interface CleanupOptions {
  signal?: AbortSignal;
  now?: () => number;
  batchSize?: number;
  maxBatches?: number;
  /** Delay before a second removal attempt when the first one left bytes behind. */
  settleMs?: number;
}

export interface CleanupResult {
  status: "idle" | "ok" | "partial" | "retry";
  claimed: number;
  removed: number;
  confirmed: number;
  deferred: number;
  requeued: number;
  batches: number;
  /** True when the last batch was full: the next scheduled run has more work. */
  more: boolean;
}

/** Counts only, and only when the sweep did not fully succeed: a partial or
 * failed run must be visible without leaking what it touched. */
function report(result: CleanupResult): void {
  if (result.status === "ok" || result.status === "idle") return;
  console.error(JSON.stringify({ event: "chat_media_cleanup", status: result.status,
    claimed: result.claimed, removed: result.removed, confirmed: result.confirmed,
    deferred: result.deferred, requeued: result.requeued, batches: result.batches }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_WORK_MS = 90_000;
const SAFETY_MARGIN_MS = 5_000;
const MAX_BATCH_SIZE = 100;
const MAX_BATCHES = 20;

function parseCandidate(value: unknown): CleanupCandidate {
  if (!value || typeof value !== "object") throw new Error("Invalid cleanup work");
  const v = value as Record<string, unknown>;
  const bucket = v.bucket;
  if (bucket !== "findback-chat-media" && bucket !== "findback-chat-moderation-evidence") {
    throw new Error("Invalid cleanup work");
  }
  if (typeof v.mediaId !== "string" || !UUID.test(v.mediaId)
    || typeof v.generation !== "string" || !UUID.test(v.generation)
    || typeof v.objectKey !== "string") throw new Error("Invalid cleanup work");
  // The key prefix is bound to the bucket, so one bucket can never address the
  // other bucket's namespace even if a caller-controlled row were malformed.
  const prefix = bucket === "findback-chat-media" ? "attachments/" : "evidence/";
  if (!v.objectKey.startsWith(prefix) || !UUID.test(v.objectKey.slice(prefix.length))) {
    throw new Error("Invalid cleanup work");
  }
  return { bucket, mediaId: v.mediaId, generation: v.generation, objectKey: v.objectKey };
}

/** Best-effort keyset position from a raw candidate row; never throws. */
function cursorOf(value: unknown): CleanupCursor | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // Any text is a valid keyset position, including the empty string: a row that
  // cannot be removed must still be paged past, or it is re-claimed forever.
  if (typeof v.bucket !== "string" || typeof v.objectKey !== "string") return null;
  return { bucket: v.bucket, objectKey: v.objectKey };
}

/** Racing cancellation is required even for ports that ignore their signal. */
async function abortable<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let off = () => {};
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("Work cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    off = () => signal.removeEventListener("abort", onAbort);
  });
  try { return await Promise.race([abort, fn()]); } finally { off(); }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return abortable(signal, () => new Promise<void>(resolve => setTimeout(resolve, ms)));
}

export async function sweepChatMediaCleanup(
  io: CleanupPorts,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const now = options.now ?? Date.now;
  const batchSize = Math.min(Math.max(options.batchSize ?? MAX_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const maxBatches = Math.max(options.maxBatches ?? MAX_BATCHES, 1);
  const settleMs = Math.max(options.settleMs ?? 750, 0);
  const deadline = now() + MAX_WORK_MS;
  const timerAbort = new AbortController();
  const signal = AbortSignal.any([timerAbort.signal, ...(options.signal ? [options.signal] : [])]);
  const timer = setTimeout(() => timerAbort.abort(), MAX_WORK_MS);
  const result: CleanupResult = {
    status: "idle", claimed: 0, removed: 0, confirmed: 0, deferred: 0, requeued: 0, batches: 0, more: false,
  };
  const checkpoint = () => {
    signal.throwIfAborted();
    if (now() >= deadline - SAFETY_MARGIN_MS) throw new Error("Work expired");
  };
  let cursor: CleanupCursor | null = null;
  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      checkpoint();
      const raw = await abortable(signal, () => io.claim(batchSize, cursor, signal));
      if (!Array.isArray(raw) || raw.length > batchSize) throw new Error("Invalid cleanup work");
      if (raw.length === 0) {
        result.more = false;
        result.status = result.deferred > 0 ? "partial" : result.claimed > 0 ? "ok" : "idle";
        report(result);
        return result;
      }
      result.batches += 1;
      result.more = raw.length === batchSize;
      for (const item of raw) {
        checkpoint();
        // Advance the keyset position from the raw row before validating it: an
        // unparseable row must not be re-claimed ahead of the rest forever.
        const position = cursorOf(item);
        if (position) cursor = position;
        // Validate before any Storage call so a malformed row cannot address an
        // unintended bucket or key. It still consumes the claimed slot and is
        // retried only after the canonical row is corrected.
        let candidate: CleanupCandidate;
        try { candidate = parseCandidate(item); } catch { result.deferred += 1; continue; }
        result.claimed += 1;
        try {
          await abortable(signal, () => io.remove(candidate, signal));
          let present = await abortable(signal, () => io.exists(candidate, signal));
          if (present) {
            // A removal that leaves bytes behind is retried once after a short
            // settle delay, then left unacknowledged for the next sweep.
            await delay(settleMs, signal);
            checkpoint();
            await abortable(signal, () => io.remove(candidate, signal));
            present = await abortable(signal, () => io.exists(candidate, signal));
          }
          if (present) { result.deferred += 1; continue; }
          // Never acknowledge after the local deadline: an expired invocation
          // must leave the row eligible instead of recording a late success.
          checkpoint();
          result.removed += 1;
          const acknowledged = await abortable(signal, () => io.confirm(candidate, signal));
          if (!acknowledged) { result.deferred += 1; continue; }
          result.confirmed += 1;
          // Bytes that land after acknowledgement are exactly the late write the
          // tombstone exists for: re-arm it instead of orphaning the object.
          if (await abortable(signal, () => io.exists(candidate, signal))) {
            try {
              await abortable(signal, () => io.recheck(candidate, signal));
              result.requeued += 1;
            } catch {
              // The tombstone still re-checks on its own schedule; never fail the
              // whole sweep for a lost re-arm.
            }
          }
        } catch {
          if (signal.aborted) throw new Error("Work cancelled");
          result.deferred += 1;
        }
      }
    }
    result.status = result.deferred > 0 ? "partial" : "ok";
    report(result);
    return result;
  } catch {
    // Never return object keys, generations or raw SDK errors.
    result.status = "retry";
    report(result);
    return result;
  } finally {
    clearTimeout(timer);
    timerAbort.abort();
  }
}
