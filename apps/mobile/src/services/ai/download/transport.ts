/**
 * WS-C chunk transport: resumable fetch with redirect + byte-bound policy.
 *
 * Pure transport logic over an injected `fetch` (fake in tests — never real
 * network in unit tests). Range resume, redirect policy, byte bound,
 * progress reporting, abort, and the sidecar journal live here; bytes land
 * in memory and the caller persists them through `storage.ts`.
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

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
  const expectedSha = options.expectedSha ?? "";
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
    options.onProgress?.({ received, total, offset });
  };

  const body = active.body;
  if (body !== null && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        throwIfAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) push(value as Uint8Array);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore lock-release failures on fake streams.
      }
    }
  } else {
    throwIfAborted(options.signal);
    const buffer = await active.arrayBuffer();
    push(new Uint8Array(buffer));
  }

  const bytes = new Uint8Array(received);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }

  return {
    bytes,
    bytesReceived: received,
    total,
    journal: { url: current, offset: offset + received, sha: expectedSha },
  };
}
