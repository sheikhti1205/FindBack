// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerTransfer, type PeerTransferDescriptor, type PeerTransferChannel } from "./peerTransfer";
import { MEDIA_MAX_BYTES } from "./media";

const crypto = webcrypto as unknown as Crypto;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const owner of opened.splice(0)) owner.close(); vi.useRealTimers(); });
const turn = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

class Channel extends EventTarget implements PeerTransferChannel {
  readyState: "open" | "closed" = "open";
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  protocol = "norfold-sync-v1";
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Array<string | ArrayBuffer> = [];
  peer!: Channel;
  transform: (data: string | ArrayBuffer) => string | ArrayBuffer = data => data;
  stallAfterBinary = false;
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed");
    const copy = typeof data === "string" ? data : data.slice(0);
    this.sent.push(copy);
    if (this.stallAfterBinary && data instanceof ArrayBuffer) this.bufferedAmount = 1_000_000;
    queueMicrotask(() => {
      if (this.peer.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data: this.transform(copy) }));
    });
  }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event("bufferedamountlow")); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed"; this.dispatchEvent(new Event("close")); this.peer.close();
  }
}
function pair() { const a = new Channel(), b = new Channel(); a.peer = b; b.peer = a; return { a, b }; }
async function fixture(byteSize = 40_000, kind: "history" | "media" = "history") {
  const bytes = Uint8Array.from({ length: byteSize }, (_, n) => n % 251).buffer;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  const descriptor: PeerTransferDescriptor = { version: 1, transferId: id(3), conversationId: id(4),
    kind, byteSize, sha256, ...(kind === "media" ? { attachmentId: id(5) } : {}) };
  return { bytes, descriptor };
}
function lane(channel: Channel, options: { authorize?: () => boolean | Promise<boolean>;
  commit?: (descriptor: PeerTransferDescriptor, bytes: ArrayBuffer, signal: AbortSignal) => Promise<void>;
  onFailure?: () => void; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const lane = createPeerTransfer(channel, { crypto, signal: options.signal ?? new AbortController().signal,
    authorize: options.authorize ?? (() => true), commit: options.commit ?? (async () => undefined),
    onFailure: options.onFailure ?? (() => undefined), timeoutMs: options.timeoutMs ?? 5_000 });
  opened.push(lane); return lane;
}

describe("authenticated peer transfer lane", () => {
  it("accepts the canonical maximum media size rather than a smaller transport limit", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture(MEDIA_MAX_BYTES, "media");
    let size = 0; const sender = lane(a); lane(b, { commit: async (_entry, payload) => { size = payload.byteLength; } });
    await sender.send(descriptor, bytes); expect(size).toBe(MEDIA_MAX_BYTES);
  });
  it("does not serve a payload when the sending owner has lost authority", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    const sender = lane(a, { authorize: () => false }); lane(b);
    await expect(sender.send(descriptor, bytes)).rejects.toThrow(); expect(a.sent).toHaveLength(0);
  });
  it("stops serving chunks when authority expires during backpressure", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture(); a.stallAfterBinary = true;
    let allowed = true; const sender = lane(a, { authorize: () => allowed }); lane(b);
    const send = sender.send(descriptor, bytes); await turn(); await turn();
    allowed = false; a.drain();
    await expect(send).rejects.toThrow(); expect(a.sent.filter(packet => packet instanceof ArrayBuffer)).toHaveLength(1);
  });
  it("moves a hash-verified payload in moderate ordered chunks and ACKs only after commit", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    const received: ArrayBuffer[] = [], committed: string[] = [];
    const sender = lane(a); lane(b, { commit: async (entry, payload) => { received.push(payload); committed.push(entry.transferId); } });
    await sender.send(descriptor, bytes);
    expect(received).toEqual([bytes]); expect(committed).toEqual([descriptor.transferId]);
    const chunks = a.sent.filter((packet): packet is ArrayBuffer => packet instanceof ArrayBuffer);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(packet => packet.byteLength <= 16_384)).toBe(true);
    expect(b.sent.filter(packet => typeof packet === "string").map(packet => JSON.parse(packet as string).type)).toEqual(["READY", "DONE"]);
  });
  it("sends no bytes until the receiving owner authorizes the transfer", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    let permit!: (value: boolean) => void;
    const allowed = new Promise<boolean>(resolve => { permit = resolve; });
    const sender = lane(a); lane(b, { authorize: () => allowed });
    const send = sender.send(descriptor, bytes); await turn();
    expect(a.sent.filter(packet => packet instanceof ArrayBuffer)).toHaveLength(0);
    permit(true); await send;
  });
  it("waits for bufferedAmount backpressure rather than queueing a giant payload", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture(); a.stallAfterBinary = true;
    const sender = lane(a); lane(b);
    const send = sender.send(descriptor, bytes); await turn(); await turn();
    expect(a.sent.filter(packet => packet instanceof ArrayBuffer)).toHaveLength(1);
    a.stallAfterBinary = false; a.drain(); await send;
    expect(a.sent.filter(packet => packet instanceof ArrayBuffer).length).toBeGreaterThan(1);
  });
  it("never commits corrupted bytes and closes into fallback", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    let commits = 0, failures = 0;
    a.transform = packet => {
      if (packet instanceof ArrayBuffer) { const view = new Uint8Array(packet); view[view.length - 1] = view[view.length - 1]! ^ 1; }
      return packet;
    };
    const sender = lane(a, { onFailure: () => { failures++; } }); lane(b, { commit: async () => { commits++; } });
    await expect(sender.send(descriptor, bytes)).rejects.toThrow("Peer repair unavailable");
    expect(commits).toBe(0); expect(failures).toBe(1); expect(a.readyState).toBe("closed");
  });
  it("revalidates authorization after transfer and before durable commit", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    let allowed = true, commits = 0;
    a.transform = packet => { if (typeof packet === "string" && JSON.parse(packet).type === "END") allowed = false; return packet; };
    const sender = lane(a); lane(b, { authorize: () => allowed, commit: async () => { commits++; } });
    await expect(sender.send(descriptor, bytes)).rejects.toThrow(); expect(commits).toBe(0);
  });
  it("does not ACK before the receiving owner's commit completes", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    let complete!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const committing = new Promise<void>(resolve => { started = resolve; });
    const sender = lane(a); lane(b, { commit: async () => { started(); await pending; } });
    let done = false; const send = sender.send(descriptor, bytes).then(() => { done = true; });
    await committing; expect(done).toBe(false);
    expect(b.sent.some(packet => typeof packet === "string" && JSON.parse(packet).type === "DONE")).toBe(false);
    complete(); await send; expect(done).toBe(true);
  });
  it("never ACKs a commit after the authority lease is revoked", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    let allowed = true, complete!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const committing = new Promise<void>(resolve => { started = resolve; });
    const sender = lane(a); lane(b, { authorize: () => allowed, commit: async () => { started(); await pending; } });
    const send = sender.send(descriptor, bytes); await committing; allowed = false; complete();
    await expect(send).rejects.toThrow();
    expect(b.sent.some(packet => typeof packet === "string" && JSON.parse(packet).type === "DONE")).toBe(false);
  });
  it("rejects a chunk with a forged offset before import", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture(); let committed = false;
    a.transform = packet => { if (packet instanceof ArrayBuffer) new DataView(packet).setUint32(20, 1, false); return packet; };
    const sender = lane(a); lane(b, { commit: async () => { committed = true; } });
    await expect(sender.send(descriptor, bytes)).rejects.toThrow(); expect(committed).toBe(false);
  });
  it("rejects oversized or extra-field descriptors before sending or allocating", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture();
    const sender = lane(a); lane(b);
    await expect(sender.send({ ...descriptor, byteSize: 100_000_000 }, bytes)).rejects.toThrow();
    expect(a.sent).toHaveLength(0);
    a.send(JSON.stringify({ version: 1, type: "BEGIN", descriptor: { ...descriptor, body: "not signaling" } }));
    await turn(); expect(b.readyState).toBe("closed");
  });
  it("aborts a backpressured send immediately on owner close", async () => {
    const { a, b } = pair(), { bytes, descriptor } = await fixture(); a.stallAfterBinary = true;
    const controller = new AbortController(), sender = lane(a, { signal: controller.signal }); lane(b);
    const send = sender.send(descriptor, bytes); await turn(); await turn(); controller.abort();
    await expect(send).rejects.toThrow(); expect(a.readyState).toBe("closed");
  });
  it("bounds a missing READY response with a deadline and normal-sync fallback", async () => {
    vi.useFakeTimers(); const { a } = pair(), { bytes, descriptor } = await fixture();
    let failures = 0; const sender = lane(a, { timeoutMs: 1_000, onFailure: () => { failures++; } });
    const result = sender.send(descriptor, bytes).catch(() => "failed");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toBe("failed"); expect(failures).toBe(1); expect(a.readyState).toBe("closed");
  });
  it("rejects unordered or unreliable channels before using them", () => {
    const { a } = pair(); a.ordered = false;
    expect(() => lane(a)).toThrow(); a.ordered = true; a.maxRetransmits = 0;
    expect(() => lane(a)).toThrow();
  });
});
