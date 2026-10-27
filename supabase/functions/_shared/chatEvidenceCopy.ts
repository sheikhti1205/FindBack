/** Exact-byte evidence copy. No image transformation, reporter authority,
 * object deletion, signed URLs, or legacy evidence-commit bypass lives here. */
export interface EvidenceJob {
  id: string;
  reportId: string;
  sourceAttachmentId: string;
  generation: string;
  workToken: string;
  workExpiresAt: string;
  expiresAt: string;
  sourceBucket: "findback-chat-media";
  sourceObjectKey: string;
  bucket: "findback-chat-moderation-evidence";
  objectKey: string;
  sha256: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
  width: number;
  height: number;
}

export interface EvidenceCopyPorts {
  claim(signal: AbortSignal): Promise<unknown>;
  /** null means confirmed not-found, not permission/network failure. */
  read(bucket: string, key: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  /** Must write immutably: upsert:false. Every attempt is read back afterwards. */
  write(job: EvidenceJob, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Must use findback_finish_chat_media_evidence_job, never legacy commit. */
  finish(job: EvidenceJob, signal: AbortSignal): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ATTEMPT_MS = 90_000;
const LEASE_MARGIN_MS = 5_000;

function parseJob(value: unknown): EvidenceJob {
  if (!value || typeof value !== "object") throw new Error("Invalid work");
  const v = value as Record<string, unknown>;
  for (const name of ["id", "reportId", "sourceAttachmentId", "generation", "workToken"]) {
    if (typeof v[name] !== "string" || !UUID.test(v[name])) throw new Error("Invalid work");
  }
  if (v.sourceBucket !== "findback-chat-media" || v.bucket !== "findback-chat-moderation-evidence"
    || typeof v.sourceObjectKey !== "string" || !v.sourceObjectKey.startsWith("attachments/")
    || !UUID.test(v.sourceObjectKey.slice("attachments/".length))
    || typeof v.objectKey !== "string" || !v.objectKey.startsWith("evidence/")
    || !UUID.test(v.objectKey.slice("evidence/".length))
    || typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)
    || !["image/jpeg", "image/png", "image/webp"].includes(String(v.mime))) throw new Error("Invalid work");
  for (const [name, max] of [["bytes", MAX_BYTES], ["width", 8192], ["height", 8192]] as const) {
    if (typeof v[name] !== "number" || !Number.isInteger(v[name]) || v[name] < 1 || v[name] > max) throw new Error("Invalid work");
  }
  if (typeof v.workExpiresAt !== "string" || !Number.isFinite(Date.parse(v.workExpiresAt))
    || typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt))
    || Date.parse(v.workExpiresAt) > Date.parse(v.expiresAt)) throw new Error("Invalid work");
  // Pick only canonical fields. Never propagate unexpected reporter/actor data.
  const { id, reportId, sourceAttachmentId, generation, workToken, workExpiresAt, expiresAt,
    sourceBucket, sourceObjectKey, bucket, objectKey, sha256, mime, bytes, width, height } = v;
  return { id, reportId, sourceAttachmentId, generation, workToken, workExpiresAt, expiresAt,
    sourceBucket, sourceObjectKey, bucket, objectKey, sha256, mime, bytes, width, height } as EvidenceJob;
}

/** Racing cancellation is necessary even for ports that ignore their signal.
 * Their late result cannot cause a subsequent write/finish in this orchestrator. */
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

async function verifiedBytes(stream: ReadableStream<Uint8Array>, job: EvidenceJob, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(job.bytes);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(signal, () => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || offset + value.length > bytes.length) throw new Error("Invalid evidence bytes");
      bytes.set(value, offset); offset += value.length;
    }
    if (offset !== bytes.length) throw new Error("Invalid evidence bytes");
    const digest = new Uint8Array(await abortable(signal, () => crypto.subtle.digest("SHA-256", bytes)));
    const sha = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    if (sha !== job.sha256) throw new Error("Invalid evidence bytes");
    return bytes;
  } finally {
    // Best-effort cancellation must not allow a stuck underlying source to
    // hold the invocation open; the SDK fetch is also bound to this signal.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function copyOneChatEvidence(
  io: EvidenceCopyPorts,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<{ status: "idle" | "attached" | "retry" }> {
  const now = options.now ?? Date.now;
  let deadline = now() + MAX_ATTEMPT_MS;
  const timerAbort = new AbortController();
  const signal = AbortSignal.any([timerAbort.signal, ...(options.signal ? [options.signal] : [])]);
  let timer = setTimeout(() => timerAbort.abort(), MAX_ATTEMPT_MS);
  const checkpoint = () => {
    signal.throwIfAborted();
    if (now() >= deadline) throw new Error("Work expired");
  };
  try {
    checkpoint();
    const raw = await abortable(signal, () => io.claim(signal));
    checkpoint();
    if (raw === null) return { status: "idle" };
    const job = parseJob(raw);
    deadline = Math.min(deadline, Date.parse(job.workExpiresAt) - LEASE_MARGIN_MS, Date.parse(job.expiresAt) - LEASE_MARGIN_MS);
    checkpoint();
    clearTimeout(timer);
    timer = setTimeout(() => timerAbort.abort(), deadline - now());
    const read = async (bucket: string, key: string) => {
      checkpoint();
      const body = await abortable(signal, () => io.read(bucket, key, signal));
      checkpoint();
      return body ? await verifiedBytes(body, job, signal) : null;
    };
    let destination = await read(job.bucket, job.objectKey);
    if (!destination) {
      const source = await read(job.sourceBucket, job.sourceObjectKey);
      if (!source) throw new Error("Source unavailable");
      checkpoint();
      try { await abortable(signal, () => io.write(job, source, signal)); }
      catch { checkpoint(); /* Lost success/conflict is safe only after exact read-back. */ }
      destination = await read(job.bucket, job.objectKey);
      if (!destination) throw new Error("Copy unavailable");
    }
    checkpoint();
    await abortable(signal, () => io.finish(job, signal));
    // SQL success is authoritative even if its response crosses our local
    // safety margin. A failed/aborted response still follows the retry path.
    return { status: "attached" };
  } catch {
    // Do not return private IDs, paths, tokens, byte content or raw SDK errors.
    // Leave the canonical row untouched; discovery can retry after lease expiry.
    return { status: "retry" };
  } finally {
    clearTimeout(timer);
    timerAbort.abort();
  }
}
