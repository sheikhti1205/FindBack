// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaTransport, PhotoUnavailableError, type MediaTransportPorts } from "./mediaTransport";
import { mediaFixture } from "./mediaTestDoubles";
import type { MediaMetadata } from "./media";

// Synthetic IDs and image bytes only; never deployed accounts/credentials.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { accountId: id(1), deviceId: id(2) };
const fixture = () => mediaFixture(id(3), id(4), { expiresAt: Date.now() + 60_000 });
const reply = (m: MediaMetadata) => ({ attachmentId: m.id, sha256: m.sha256, mime: m.mime,
  bytes: m.byteSize, width: m.width, height: m.height });
const delivery = (m: MediaMetadata) => ({ version: 1, ...reply(m), messageId: m.messageId,
  expiresAt: new Date(m.expiresAt!).toISOString() });
function setup(request: MediaTransportPorts["request"], rpc: MediaTransportPorts["rpc"] = async () => null) {
  const owner = new AbortController();
  return { owner, transport: createMediaTransport(scope, owner.signal, { request, rpc }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("media transport boundary", () => {
  it("posts stable exact binary identity and verifies the entire reply without ACK", async () => {
    const { metadata, bytes } = await fixture();
    const requests: Array<{ method: string; headers: Headers; body: ArrayBuffer }> = [];
    let acks = 0;
    const { transport } = setup(async (input) => {
      requests.push({ method: input.method, headers: new Headers(input.headers), body: input.body!.slice(0) });
      return Response.json(reply(metadata));
    }, async () => { acks++; return null; });
    await transport.upload(metadata, bytes);
    await transport.upload(metadata, bytes);
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.method).toBe("POST"); expect(r.body).toEqual(bytes);
      expect(r.headers.get("x-attachment-id")).toBe(id(3));
      expect(r.headers.get("x-message-id")).toBe(id(4));
      expect(r.headers.get("content-type")).toBe("image/png");
    }
    expect(acks).toBe(0);
  });

  it.each(["attachmentId", "sha256", "mime", "bytes", "width", "height"])("rejects mismatched POST %s", async (key) => {
    const { metadata, bytes } = await fixture();
    const bad = { ...reply(metadata), [key]: key === "bytes" || key === "width" || key === "height" ? 999 : "wrong" };
    const { transport } = setup(async () => Response.json(bad));
    await expect(transport.upload(metadata, bytes)).rejects.toThrow();
  });

  it("copies caller metadata and bytes before asynchronous validation", async () => {
    const { metadata, bytes } = await fixture(); const original = bytes.slice(0), originalReply = reply(metadata);
    let sent: ArrayBuffer | undefined;
    const { transport } = setup(async (input) => { sent = input.body; return Response.json(originalReply); });
    const pending = transport.upload(metadata, bytes);
    metadata.id = id(9); new Uint8Array(bytes).fill(0);
    await pending; expect(sent).toEqual(original);
  });

  it("rejects malformed local image assertions before contacting the network", async () => {
    const { metadata, bytes } = await fixture(); let calls = 0;
    const { transport } = setup(async () => { calls++; return Response.json(reply(metadata)); });
    for (const m of [{ ...metadata, width: metadata.width + 1 }, { ...metadata, sha256: "0".repeat(64) },
      { ...metadata, mime: "image/jpeg" as const }, { ...metadata, byteSize: 20_971_521 }]) {
      await expect(transport.upload(m, bytes)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("reads exact GET bytes with or without exposed Content-Length and no delivery lookup", async () => {
    const { metadata, bytes } = await fixture(); let calls = 0;
    for (const length of [undefined, String(bytes.byteLength)]) {
      const { transport } = setup(async (input) => {
        expect(input.method).toBe("GET"); expect(input.body).toBeUndefined();
        expect(new Headers(input.headers).get("x-attachment-id")).toBe(id(3));
        return new Response(bytes.slice(0), { headers: { "content-type": "image/png", ...(length ? { "content-length": length } : {}) } });
      }, async () => { calls++; return []; });
      expect(await transport.download(metadata)).toEqual(bytes);
    }
    expect(calls).toBe(0);
  });

  it.each(["short", "long", "hash", "mime", "length", "dimension", "expired"])("rejects invalid GET %s", async (kind) => {
    const { metadata, bytes } = await fixture();
    let data = bytes.slice(0); const headers = { "content-type": "image/png", "content-length": String(bytes.byteLength) };
    if (kind === "short") data = bytes.slice(1);
    if (kind === "long") data = new Uint8Array(bytes.byteLength + 1).buffer;
    if (kind === "hash") new Uint8Array(data)[bytes.byteLength - 1] = new Uint8Array(data)[bytes.byteLength - 1]! ^ 1;
    if (kind === "mime") headers["content-type"] = "text/plain";
    if (kind === "length") headers["content-length"] = "999999999999999999";
    if (kind === "dimension") metadata.width++;
    if (kind === "expired") metadata.expiresAt = 1;
    const { transport } = setup(async () => new Response(data, { headers }));
    await expect(transport.download(metadata)).rejects.toThrow();
  });

  it("cancels an overlong stream without accepting or retaining extra chunks", async () => {
    const { metadata, bytes } = await fixture(); let cancelled = false, reads = 0;
    const { transport } = setup(async () => new Response(new ReadableStream({ pull(c) {
      reads++; c.enqueue(reads === 1 ? new Uint8Array(bytes) : new Uint8Array(1));
    }, cancel() { cancelled = true; } }), { headers: { "content-type": "image/png" } }));
    await expect(transport.download(metadata)).rejects.toThrow();
    expect(cancelled).toBe(true); expect(reads).toBeLessThanOrEqual(3);
  });

  it.each([0, 1])("owner abort cancels stream at highWaterMark %s, including reader handoff", async (highWaterMark) => {
    const { metadata } = await fixture(); const reading = deferred<void>(); let cancelled = false;
    const { transport, owner } = setup(async () => new Response(new ReadableStream({ pull() {
      reading.resolve(); return new Promise(() => undefined);
    }, cancel() { cancelled = true; } }, { highWaterMark }), { headers: { "content-type": "image/png" } }));
    const pending = transport.download(metadata); const rejected = expect(pending).rejects.toThrow();
    await reading.promise; owner.abort(); await rejected; expect(cancelled).toBe(true);
  });

  it("deadline aborts even a request port that never resolves", async () => {
    const { metadata } = await fixture(); vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const { transport } = setup((input) => { signal = input.signal; return new Promise(() => undefined); });
    const rejected = expect(transport.download(metadata)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(90_001); await rejected; expect(signal?.aborted).toBe(true);
  });

  it("cancels a response arriving after its owner is already closed", async () => {
    const { metadata } = await fixture(); const response = deferred<Response>(); let cancelled = false;
    const { transport, owner } = setup(() => response.promise);
    const rejected = expect(transport.download(metadata)).rejects.toThrow(); owner.abort(); await rejected;
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve(); await Promise.resolve(); expect(cancelled).toBe(true);
  });

  it.each([401, 404, 503])("discards private error bodies on HTTP %s", async (status) => {
    const { metadata } = await fixture(); let cancelled = false;
    const { transport } = setup(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode("private-storage-key blocked-peer"));
    }, cancel() { cancelled = true; } }), { status }));
    await expect(transport.download(metadata)).rejects.toThrow("Photo could not sync. Try again.");
    expect(cancelled).toBe(true);
  });

  it("gives GET 404 an opaque unavailable outcome without exposing private reason or body", async () => {
    const { metadata } = await fixture(); let cancelled = false;
    const { transport } = setup(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode("private missing blocked deleted storage-key"));
    }, cancel() { cancelled = true; } }), { status: 404 }));
    const error = await transport.download(metadata).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PhotoUnavailableError", message: "Photo could not sync. Try again." });
    expect(Object.keys(error as object)).not.toContain("status");
    expect(String(error)).not.toMatch(/blocked|deleted|storage-key|404/);
    expect(cancelled).toBe(true);
  });

  it("gives a trusted passed expiry the same unavailable outcome without contacting the network", async () => {
    const { metadata } = await fixture(); let calls = 0;
    const { transport } = setup(async () => { calls++; throw Error("unexpected"); });
    await expect(transport.download({ ...metadata, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ name: "PhotoUnavailableError" });
    expect(calls).toBe(0);
  });

  it.each([401, 503])("keeps GET HTTP %s retryable rather than inventing permanent unavailability", async (status) => {
    const { metadata } = await fixture();
    const { transport } = setup(async () => new Response(null, { status }));
    await expect(transport.download(metadata)).rejects.toMatchObject({ name: "Error", message: "Photo could not sync. Try again." });
  });

  it("does not classify a POST 404 as permanently unavailable", async () => {
    const { metadata, bytes } = await fixture();
    const { transport } = setup(async () => new Response(null, { status: 404 }));
    await expect(transport.upload(metadata, bytes)).rejects.toMatchObject({ name: "Error" });
  });

  it("does not let a raw port rejection spoof the opaque unavailable outcome", async () => {
    const { metadata } = await fixture();
    const { transport } = setup(async () => { throw Object.assign(new Error("private raw failure"), { name: "PhotoUnavailableError" }); });
    await expect(transport.download(metadata)).rejects.toMatchObject({ name: "Error", message: "Photo could not sync. Try again." });
  });

  it("sanitizes even an actual unavailable error rejected by an untrusted request port", async () => {
    const { metadata } = await fixture();
    const { transport } = setup(async () => { throw new PhotoUnavailableError(); });
    const error = await transport.download(metadata).catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(PhotoUnavailableError);
    expect(error).toMatchObject({ name: "Error" });
  });

  it("discards valid bytes if their trusted expiry passes while the GET is in flight", async () => {
    const { metadata, bytes } = await fixture();
    const { transport } = setup(async () => {
      vi.spyOn(Date, "now").mockReturnValue(metadata.expiresAt! + 1);
      return new Response(bytes, { headers: { "content-type": metadata.mime } });
    });
    try { await expect(transport.download(metadata)).rejects.toBeInstanceOf(PhotoUnavailableError); }
    finally { vi.restoreAllMocks(); }
  });

  it("lets owner abort win a racing GET404 and cancels the body without terminal classification", async () => {
    const { metadata } = await fixture(); let cancelled = false;
    const { transport, owner } = setup(async () => {
      owner.abort();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
    });
    await expect(transport.download(metadata)).rejects.toMatchObject({ name: "Error" });
    expect(cancelled).toBe(true);
  });

  it("does not trust a redirected404 as an unavailable-photo response", async () => {
    const { metadata } = await fixture(), response = new Response(null, { status: 404 });
    Object.defineProperty(response, "redirected", { value: true });
    const { transport } = setup(async () => response);
    await expect(transport.download(metadata)).rejects.toMatchObject({ name: "Error" });
  });

  it("bounds upload JSON before parsing and cancels excess data", async () => {
    const { metadata, bytes } = await fixture(); let cancelled = false;
    const { transport } = setup(async () => new Response(new ReadableStream({ pull(c) {
      c.enqueue(new Uint8Array(4097));
    }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
    await expect(transport.upload(metadata, bytes)).rejects.toThrow(); expect(cancelled).toBe(true);
  });

  it("validates entire delivery pages without inventing parent direction or cursor", async () => {
    const { metadata } = await fixture(); const calls: unknown[] = [];
    const { transport } = setup(async () => { throw Error("unexpected"); }, async (input) => {
      calls.push(input); return input.name === "findback_fetch_chat_media_delivery" ? [delivery(metadata)] : null;
    });
    const rows = await transport.fetchDeliveries();
    expect(rows).toEqual([{ id: id(3), messageId: id(4), sha256: metadata.sha256, mime: "image/png",
      byteSize: metadata.byteSize, width: metadata.width, height: metadata.height, expiresAt: metadata.expiresAt }]);
    await transport.ack(id(3));
    expect(calls).toEqual([
      { name: "findback_fetch_chat_media_delivery", args: { p_account_id: id(1), p_device_id: id(2) }, signal: expect.any(AbortSignal) },
      { name: "findback_ack_chat_media_delivery", args: { p_account_id: id(1), p_device_id: id(2), p_attachment_id: id(3) }, signal: expect.any(AbortSignal) },
    ]);
  });

  it.each(["version", "array", "duplicate", "duplicate-message", "expiry", "oversize", "envelope", "extra"])("rejects invalid delivery %s", async (kind) => {
    const { metadata } = await fixture(); const row = delivery(metadata); let data: unknown = [row];
    if (kind === "version") data = [{ ...row, version: 2 }];
    if (kind === "array") data = [[]];
    if (kind === "duplicate") data = [row, row];
    if (kind === "duplicate-message") data = [row, { ...row, attachmentId: id(8) }];
    if (kind === "expiry") data = [{ ...row, expiresAt: "tomorrow" }];
    if (kind === "oversize") data = Array(101).fill(row);
    if (kind === "envelope") data = { items: [row] };
    if (kind === "extra") data = [{ ...row, storageKey: "private" }];
    const { transport } = setup(async () => { throw Error("unexpected"); }, async () => data);
    await expect(transport.fetchDeliveries()).rejects.toThrow();
  });

  it("refuses ACK reply objects and does not issue work after owner closure", async () => {
    let calls = 0;
    const { transport, owner } = setup(async () => { throw Error("unexpected"); }, async () => { calls++; return { success: true }; });
    await expect(transport.ack(id(3))).rejects.toThrow(); owner.abort();
    await expect(transport.fetchDeliveries()).rejects.toThrow(); await expect(transport.ack(id(3))).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
