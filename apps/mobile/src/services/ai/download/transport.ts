/**
 * WS-C chunk transport: resumable fetch with redirect + byte-bound policy.
 *
 * Pure transport logic over an injected `fetch` (fake in tests — never real
 * network in unit tests). Range resume, redirect policy, byte bound,
 * progress reporting, abort, and the sidecar journal live here.
 *
 * Two consumers share one negotiation core (`negotiateDownload`):
 * - `downloadFile` buffers into memory (small files + tests only — never
 *   model weights; a ~361 MB model must not transit JS memory twice over).
 * - `downloadToSink` streams chunk-by-chunk into a `ChunkSink` (staged
 *   app-private storage) while a `StreamingHasher` folds bytes
 *   incrementally — the production model path. Peak JS memory is one
 *   network chunk, and verification hashes the staged file, not a copy.
 */

export interface DownloadJournal {
  /** Final URL after redirects. */
  readonly url: string;
  /** Resume offset: start offset + bytes received. */
  readonly offset: number;
  /** Expected SHA-256 hex carried from the manifest (may be ""). */
  readonly sha: string;
}

export type TransportErrorCode =
  | "REDIRECT_NON_HTTPS"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "OFFSET_MISMATCH"
  | "RESUME_NOT_SUPPORTED"
  | "BYTE_BOUND_EXCEEDED"
  | "ABORTED";

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
  readonly offset: number;
}

export type FetchFn = typeof fetch;

export interface DownloadFileOptions {
  /** Start offset for Range resume (bytes already staged). */
  readonly offset?: number;
  /** Expected SHA hex carried into the sidecar journal. */
  readonly expectedSha?: string;
  /** Hard cap on total bytes (offset + incoming). Inclusive. */
  readonly maxBytes?: number;
  /** Max redirects followed (default 3). */
  readonly maxRedirects?: number;
  readonly fetchFn?: FetchFn;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadFileResult {
  readonly bytes: Uint8Array;
  readonly bytesReceived: number;
  readonly total: number | null;
  readonly journal: DownloadJournal;
}

/**
 * Exactly-once, in-order byte consumer. Production appends to the staged
 * file (fsync at flush points); tests record chunks in memory.
 */
export interface ChunkSink {
  append(chunk: Uint8Array): Promise<void>;
  /** Durability point: flush staged bytes + persist the journal. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Incremental SHA-256: native MessageDigest or hash-wasm, never buffering. */
export interface StreamingHasher {
  update(chunk: Uint8Array): void;
  digestHex(): Promise<string>;
}

export interface DownloadToSinkOptions extends DownloadFileOptions {
  readonly sink: ChunkSink;
  /** When present, bytes fold into the running digest as they stream. */
  readonly hasher?: StreamingHasher;
  /** Journal durability callback (caller persists `<staging>.journal.json`). */
  readonly onJournal?: (journal: DownloadJournal) => void;
  /** Journal/flush cadence in bytes (default 1 MiB). */
  readonly journalEveryBytes?: number;
}

export interface DownloadToSinkResult {
  readonly bytesReceived: number;
  readonly total: number | null;
  readonly journal: DownloadJournal;
  /** Running digest, or null when no hasher was injected. */
  readonly actualHex: string | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_JOURNAL_EVERY_BYTES = 1024 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new TransportError("ABORTED", "download aborted");
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function parseContentRange(
  header: string | null,
  expectedStart: number,
): { start: number; end: number; total: number | null } | null {
  if (header === null || header === "") return null;
  // Shape: `bytes <start>-<end>/<total>` or `bytes <start>-<end>/*`.
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start !== expectedStart) {
    return null;
  }
  return { start, end, total };
}

/** Resume offset recorded in a journal; the next fetch starts here. */
export function journalResumeOffset(journal: DownloadJournal): number {
  return journal.offset;
}

export function createResumeJournal(
  url: string,
  offset: number,
  sha: string,
): DownloadJournal {
  return { url, offset, sha };
}

export async function downloadFile(
  url: string,
  options: DownloadFileOptions = {},
): Promise<DownloadFileResult> {
  const negotiated = await negotiateDownload(url, options);
  const { offset, maxBytes } = negotiated;

  const chunks: Uint8Array[] = [];
  let received = 0;
  const push = (view: Uint8Array): void => {
    if (view.length === 0) return;
    if (offset + received + view.length > maxBytes) {
      throw new TransportError(
        "BYTE_BOUND_EXCEEDED",
        `download exceeded byte bound ${maxBytes} while streaming`,
      );
    }
    chunks.push(view.slice());
    received += view.length;
    options.onProgress?.({ received, total: negotiated.total, offset });
  };

  await readBodyChunks(negotiated.response, options.signal, push);

  const bytes = new Uint8Array(received);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }

  return {
    bytes,
    bytesReceived: received,
    total: negotiated.total,
    journal: {
      url: negotiated.finalUrl,
      offset: offset + received,
      sha: options.expectedSha ?? "",
    },
  };
}

/**
 * Stream a download straight into a sink (production model path): chunk
 * bytes are appended exactly once, in order, and never accumulated in JS
 * memory. The hasher folds incrementally; the journal callback fires on
 * the flush cadence and at completion so a kill resumes byte-exact.
 * Abort/pause surfaces `ABORTED` after a best-effort final flush so the
 * last emitted journal stays durable — the caller persists every journal
 * it receives.
 */
export async function downloadToSink(
  url: string,
  options: DownloadToSinkOptions,
): Promise<DownloadToSinkResult> {
  const negotiated = await negotiateDownload(url, options);
  const { offset, maxBytes } = negotiated;
  const journalEvery = options.journalEveryBytes ?? DEFAULT_JOURNAL_EVERY_BYTES;
  const emitJournal = (received: number): void => {
    options.onJournal?.({
      url: negotiated.finalUrl,
      offset: offset + received,
      sha: options.expectedSha ?? "",
    });
  };

  let received = 0;
  let sinceFlush = 0;
  try {
    await readBodyChunks(negotiated.response, options.signal, async (view) => {
      if (view.length === 0) return;
      if (offset + received + view.length > maxBytes) {
        throw new TransportError(
          "BYTE_BOUND_EXCEEDED",
          `download exceeded byte bound ${maxBytes} while streaming`,
        );
      }
      await options.sink.append(view);
      options.hasher?.update(view);
      received += view.length;
      sinceFlush += view.length;
      options.onProgress?.({ received, total: negotiated.total, offset });
      if (sinceFlush >= journalEvery) {
        sinceFlush = 0;
        await options.sink.flush();
        emitJournal(received);
      }
    });
  } catch (error) {
    // Best-effort durability on abort: the staged prefix stays valid and
    // the last flushed journal is the resume truth.
    try {
      await options.sink.flush();
    } catch {
      // Flush itself failed — the error below still carries the failure.
    }
    emitJournal(received);
    try {
      await options.sink.close();
    } catch {
      // Ignore close failures when the stream already failed.
    }
    throw error;
  }
  await options.sink.flush();
  await options.sink.close();
  emitJournal(received);
  const actualHex =
    options.hasher !== undefined ? await options.hasher.digestHex() : null;
  return {
    bytesReceived: received,
    total: negotiated.total,
    journal: {
      url: negotiated.finalUrl,
      offset: offset + received,
      sha: options.expectedSha ?? "",
    },
    actualHex,
  };
}

interface NegotiatedDownload {
  readonly finalUrl: string;
  readonly response: Response;
  readonly total: number | null;
  readonly offset: number;
  readonly maxBytes: number;
}

/**
 * Shared negotiation core: offset validation, https gate, manual redirect
 * loop (https-only, bounded), status check, Range/200 resume rules,
 * Content-Range match, and the preface byte bound. Returns the live
 * response with its body unconsumed for exactly one streaming pass.
 */
async function negotiateDownload(
  url: string,
  options: DownloadFileOptions,
): Promise<NegotiatedDownload> {
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new TransportError("OFFSET_MISMATCH", "resume offset must be >= 0");
  }
  if (!isHttps(url)) {
    throw new TransportError("REDIRECT_NON_HTTPS", "download URL must be https");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchFn: FetchFn = options.fetchFn ?? fetch;
  throwIfAborted(options.signal);

  let current = url;
  let redirects = 0;
  let response: Response | null = null;

  for (;;) {
    throwIfAborted(options.signal);
    const headers: Record<string, string> = {};
    if (offset > 0) headers["Range"] = `bytes=${offset}-`;
    const fetched = await fetchFn(current, {
      headers,
      redirect: "manual",
      signal: options.signal,
    });
    if (REDIRECT_STATUSES.has(fetched.status)) {
      const location = fetched.headers.get("location");
      if (location === null || location === "") {
        throw new TransportError("HTTP_ERROR", `redirect ${fetched.status} without location`);
      }
      const next = new URL(location, current).toString();
      if (!isHttps(next)) {
        throw new TransportError(
          "REDIRECT_NON_HTTPS",
          `refusing non-https redirect to ${next}`,
        );
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new TransportError(
          "TOO_MANY_REDIRECTS",
          `too many redirects (max ${maxRedirects})`,
        );
      }
      current = next;
      continue;
    }
    response = fetched;
    break;
  }

  const active = response as Response;
  if (active.status !== 200 && active.status !== 206) {
    throw new TransportError("HTTP_ERROR", `download failed with HTTP ${active.status}`);
  }

  if (offset > 0) {
    if (active.status === 200) {
      throw new TransportError(
        "RESUME_NOT_SUPPORTED",
        "server ignored Range resume; refusing to restart over staged bytes",
      );
    }
    const range = parseContentRange(active.headers.get("content-range"), offset);
    if (range === null) {
      throw new TransportError(
        "OFFSET_MISMATCH",
        "server Content-Range does not match resume offset",
      );
    }
  }

  const lengthHeader = active.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  const total =
    active.status === 206
      ? (parseContentRange(active.headers.get("content-range"), offset)?.total ?? null)
      : (declaredLength !== null && Number.isFinite(declaredLength) ? declaredLength : null);
  if (total !== null && offset + total > maxBytes) {
    throw new TransportError(
      "BYTE_BOUND_EXCEEDED",
      `download size ${offset + total} exceeds byte bound ${maxBytes}`,
    );
  }

  return { finalUrl: current, response: active, total, offset, maxBytes };
}

/**
 * Single streaming pass over a negotiated body. `push` may be async
 * (sink append); chunks are awaited in order, so delivery is exactly-once
 * and in-order. Non-stream bodies fall back to one `arrayBuffer` push.
 */
async function readBodyChunks(
  response: Response,
  signal: AbortSignal | undefined,
  push: (view: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const body = response.body;
  if (body !== null && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) await push(value as Uint8Array);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore lock-release failures on fake streams.
      }
    }
  } else {
    throwIfAborted(signal);
    const buffer = await response.arrayBuffer();
    await push(new Uint8Array(buffer));
  }
}
