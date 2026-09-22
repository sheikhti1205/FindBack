/**
 * App-private transfer storage seams for streaming model transfers.
 *
 * Production file layout (native platform owns it): HTTP Range chunks append
 * to a per-entry temp file under app-private storage; a verified download
 * commits via atomic rename to the installed location; failures keep or
 * discard the temp prefix for resume. This module declares the seam the
 * native layer implements and ships a memory implementation for tests and
 * the web fallback. The memory implementation holds bytes only for small
 * test fixtures — production artifacts must never be buffered in JS.
 *
 * Cooperative cancellation: chunk loops poll `TransferControl.isCancelled()`
 * and abort with `TransferCancelledError`, keeping the temp prefix so a
 * later attempt resumes by byte offset (`tempBytes`).
 */

export interface TransferControl {
  isCancelled(): boolean;
}

export class TransferCancelledError extends Error {
  constructor() {
    super("Transfer cancelled.");
    this.name = "TransferCancelledError";
  }
}

export function throwIfCancelled(control: TransferControl | undefined): void {
  if (control?.isCancelled() === true) throw new TransferCancelledError();
}

/**
 * App-private storage seam. All sizes are exact byte counts; `tempBytes`
 * is the resume offset for an interrupted download (0 when no prefix).
 * `commitTemp` atomically promotes the temp prefix to installed; it must
 * leave the temp prefix in place when verification data is missing so the
 * caller can report instead of losing progress.
 */
export interface ModelTransferStore {
  /** Resume offset: bytes already staged in the temp prefix. */
  tempBytes(entryId: string): number;
  /** Appends one received chunk to the temp prefix. */
  appendTemp(entryId: string, chunk: Uint8Array): void;
  /**
   * Atomically promotes the staged temp prefix to installed. The caller
   * verifies size + hash before calling; the store only moves bytes.
   */
  commitTemp(entryId: string): void;
  /** Drops the staged temp prefix (fresh restart). */
  discardTemp(entryId: string): void;
  /**
   * Streams staged temp bytes in chunk order without buffering the whole
   * prefix (resume re-hashing path). Never called when no prefix exists.
   */
  readTemp(entryId: string, onChunk: (chunk: Uint8Array) => void): void;
  /** Removes installed bytes for an entry. */
  deleteInstalled(entryId: string): void;
  /** Exact installed size, or null when the entry is not installed. */
  installedBytes(entryId: string): number | null;
  /** Passively observed free app-private bytes, or null when unknown. */
  freeBytes(): number | null;
  /**
   * Streams installed bytes in chunk order without buffering the whole
   * artifact (export hashing path). Never called for missing entries.
   */
  readInstalled(entryId: string, onChunk: (chunk: Uint8Array) => void): void;
}

/**
 * Memory implementation for tests and the web fallback. Holds chunk arrays
 * (never concatenated except in `readInstalled` per-chunk replay); test
 * fixtures only — not for production artifacts.
 */
export class MemoryTransferStore implements ModelTransferStore {
  private readonly temp = new Map<string, Uint8Array[]>();
  private readonly installed = new Map<string, Uint8Array[]>();
  private freeBytesValue: number | null;

  constructor(options?: { freeBytes?: number | null }) {
    this.freeBytesValue = options?.freeBytes ?? null;
  }

  setFreeBytes(value: number | null): void {
    this.freeBytesValue = value;
  }

  tempBytes(entryId: string): number {
    return (this.temp.get(entryId) ?? []).reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
  }

  appendTemp(entryId: string, chunk: Uint8Array): void {
    const prefix = this.temp.get(entryId) ?? [];
    prefix.push(chunk.slice());
    this.temp.set(entryId, prefix);
  }

  commitTemp(entryId: string): void {
    const prefix = this.temp.get(entryId);
    if (prefix == null) {
      throw new Error(`commitTemp with no staged prefix: ${entryId}.`);
    }
    this.installed.set(entryId, prefix);
    this.temp.delete(entryId);
  }

  discardTemp(entryId: string): void {
    this.temp.delete(entryId);
  }

  readTemp(entryId: string, onChunk: (chunk: Uint8Array) => void): void {
    const prefix = this.temp.get(entryId);
    if (prefix == null) {
      throw new Error(`readTemp with no staged prefix: ${entryId}.`);
    }
    for (const chunk of prefix) onChunk(chunk);
  }

  deleteInstalled(entryId: string): void {
    this.installed.delete(entryId);
  }

  installedBytes(entryId: string): number | null {
    const files = this.installed.get(entryId);
    if (files == null) return null;
    return files.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  freeBytes(): number | null {
    return this.freeBytesValue;
  }

  readInstalled(entryId: string, onChunk: (chunk: Uint8Array) => void): void {
    const files = this.installed.get(entryId);
    if (files == null) {
      throw new Error(`readInstalled for missing entry: ${entryId}.`);
    }
    for (const chunk of files) onChunk(chunk);
  }

  /** Test helper: stages installed bytes directly without a download. */
  seedInstalled(entryId: string, chunks: readonly Uint8Array[]): void {
    this.installed.set(
      entryId,
      chunks.map((chunk) => chunk.slice()),
    );
  }
}
