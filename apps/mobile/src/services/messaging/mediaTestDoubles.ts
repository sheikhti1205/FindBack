/**
 * Test-only doubles for the chat-media adapter suites.
 *
 * Never imported by production code. The adapters take the real byte store
 * through `MediaBytesPort`; this fake exists so a test can observe the exact
 * order of byte writes and row commits, and can plant an orphan or a stale
 * `EVICTED` entry that no production path would create on purpose.
 */
import type { MediaBytesPort } from "./history";
import { MEDIA_SWEEP_GRACE_MS, sha256Hex, type MediaMetadata, type MediaMime } from "./media";
import { buildJpeg, buildPng, buildWebp } from "../media/__fixtures__/synthetic";
import { vi } from "vitest";
import * as historyLock from "./historyLock";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Execute the real operation, then interleave work after its lock is released
 * but before the caller can consume the result. Does not replace persistence. */
export function afterNextHistoryOperation(effect: () => Promise<void>): void {
  const original = historyLock.withHistoryLock;
  vi.spyOn(historyLock, "withHistoryLock").mockImplementationOnce(async function<T>(
    accountId: string, signal: AbortSignal, required: boolean, work: () => Promise<T>,
  ): Promise<T> {
    const result = await original(accountId, signal, required, work);
    await effect();
    return result;
  });
}

interface Entry {
  bytes: ArrayBuffer;
  storedAt: number;
}

export class FakeMediaBytes implements MediaBytesPort {
  readonly entries = new Map<string, Entry>();
  /** Ordered operation trace shared with the adapter test's SQL hook. */
  readonly trace: string[];
  failPut: Error | null = null;
  failDelete: Error | null = null;

  constructor(private readonly clock: () => number = Date.now, trace: string[] = []) {
    this.trace = trace;
  }

  private key(accountId: string, attachmentId: string): string {
    return `${accountId}/${attachmentId}`;
  }

  async put(accountId: string, attachmentId: string, bytes: ArrayBuffer): Promise<void> {
    this.trace.push(`bytes:put:${attachmentId}`);
    if (this.failPut) {
      const error = this.failPut;
      this.failPut = null;
      throw error;
    }
    this.entries.set(this.key(accountId, attachmentId), { bytes: bytes.slice(0), storedAt: this.clock() });
  }

  async get(accountId: string, attachmentId: string): Promise<ArrayBuffer | null> {
    return this.entries.get(this.key(accountId, attachmentId))?.bytes.slice(0) ?? null;
  }

  async has(accountId: string, attachmentId: string): Promise<boolean> {
    return this.entries.has(this.key(accountId, attachmentId));
  }

  async delete(accountId: string, attachmentIds: readonly string[]): Promise<void> {
    this.trace.push(`bytes:delete:${attachmentIds.join(",")}`);
    if (this.failDelete) {
      const error = this.failDelete;
      this.failDelete = null;
      throw error;
    }
    for (const attachmentId of attachmentIds) this.entries.delete(this.key(accountId, attachmentId));
  }

  async keys(accountId: string): Promise<string[]> {
    const prefix = `${accountId}/`;
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  async sweep(accountId: string, keep: ReadonlySet<string>, limit: number): Promise<number> {
    const boundary = this.clock() - MEDIA_SWEEP_GRACE_MS;
    const prefix = `${accountId}/`;
    let removed = 0;
    for (const [key, row] of [...this.entries]) {
      if (removed >= limit) break;
      if (!key.startsWith(prefix)) continue;
      const attachmentId = key.slice(prefix.length);
      if (!keep.has(attachmentId) && row.storedAt <= boundary) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clearAccount(accountId: string): Promise<void> {
    const prefix = `${accountId}/`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Plant bytes without `put`: an orphan, or an `EVICTED` row that still holds bytes. */
  plant(accountId: string, attachmentId: string, bytes: ArrayBuffer, storedAt: number): void {
    this.entries.set(this.key(accountId, attachmentId), { bytes, storedAt });
  }
}

/**
 * Synthetic headers, NOT decodable photos. Adapter tests inject a decoder;
 * container and dimension verification still run against these actual bytes.
 */
export function mediaBytes(mime: MediaMime = "image/png", length = 64, fill = 9): ArrayBuffer {
  const header = mime === "image/png" ? buildPng(32, 32)
    : mime === "image/jpeg" ? buildJpeg(32, 32) : buildWebp(32, 32);
  const bytes = new Uint8Array(Math.max(length, header.length)).fill(fill);
  bytes.set(header);
  return bytes.buffer;
}

/** Valid metadata whose digest is the digest of exactly these bytes. */
export async function mediaFixture(
  id: string, messageId: string, overrides: Partial<MediaMetadata> = {},
): Promise<{ bytes: ArrayBuffer; metadata: MediaMetadata }> {
  const mime = overrides.mime ?? "image/png";
  const bytes = mediaBytes(mime, overrides.byteSize ?? 64);
  const metadata: MediaMetadata = {
    id,
    messageId,
    direction: "OUT",
    sha256: await sha256Hex(bytes),
    mime,
    byteSize: bytes.byteLength,
    width: 32,
    height: 32,
    expiresAt: null,
    ...overrides,
  };
  return { bytes, metadata };
}
