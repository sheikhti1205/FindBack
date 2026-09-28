/**
 * Exact-byte duplicate detection for report photos.
 *
 * Uses SHA-256 of raw file bytes via crypto.subtle.digest.
 * Same bytes under different name/URI = duplicate.
 * Same name but different bytes = NOT a duplicate.
 * Digest is kept with the photo record; never logged.
 */

import { throwIfAborted, withTimeout } from "../timeout";

/**
 * Per-stage budget for hashing. Hashing re-reads the full normalized bytes,
 * so a stalled digest must fail instead of hanging the batch loop.
 */
export const HASH_STAGE_TIMEOUT_MS = 30_000;

export interface HashOpts {
  /** AbortSignal threaded from the photo pipeline; abort stops the digest. */
  signal?: AbortSignal;
  /** Per-stage budget in ms (default HASH_STAGE_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface PhotoHashRegistry {
  has(hash: string): boolean;
  add(hash: string): void;
  delete(hash: string): void;
}

/** Create a synchronous Set-based hash registry for in-flight duplicate tracking. */
export function createHashRegistry(): PhotoHashRegistry {
  const set = new Set<string>();
  return {
    has: (hash: string) => set.has(hash),
    add: (hash: string) => set.add(hash),
    delete: (hash: string) => set.delete(hash),
  };
}

/**
 * Compute SHA-256 hex digest of raw file bytes.
 * Uses crypto.subtle.digest over arrayBuffer.
 * Caller should enforce reasonable size limits before calling.
 */
export async function computeSha256Hex(file: File, opts?: HashOpts): Promise<string> {
  throwIfAborted(opts?.signal);
  const stageMs = opts?.timeoutMs ?? HASH_STAGE_TIMEOUT_MS;
  const signal = opts?.signal;
  const arrayBuffer = await withTimeout(
    () => file.arrayBuffer(),
    stageMs,
    "Photo hash timed out",
    signal,
  );
  throwIfAborted(signal);
  const hashBuffer = await withTimeout(
    () => crypto.subtle.digest("SHA-256", arrayBuffer),
    stageMs,
    "Photo hash timed out",
    signal,
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute SHA-256 hex digest from a Uint8Array (for testing or pre-loaded bytes).
 */
export async function computeSha256HexFromBytes(bytes: Uint8Array, opts?: HashOpts): Promise<string> {
  throwIfAborted(opts?.signal);
  const stageMs = opts?.timeoutMs ?? HASH_STAGE_TIMEOUT_MS;
  const signal = opts?.signal;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuffer = await withTimeout(
    () => crypto.subtle.digest("SHA-256", buffer),
    stageMs,
    "Photo hash timed out",
    signal,
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}