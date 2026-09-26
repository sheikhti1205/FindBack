/**
 * Exact-byte duplicate detection for report photos.
 *
 * Uses SHA-256 of raw file bytes via crypto.subtle.digest.
 * Same bytes under different name/URI = duplicate.
 * Same name but different bytes = NOT a duplicate.
 * Digest is kept with the photo record; never logged.
 */

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
export async function computeSha256Hex(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute SHA-256 hex digest from a Uint8Array (for testing or pre-loaded bytes).
 */
export async function computeSha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}