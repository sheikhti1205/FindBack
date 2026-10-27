import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { copyOneChatEvidence, type EvidenceCopyPorts, type EvidenceJob } from "./chatEvidenceCopy.ts";

const uuid = (n: number) => `00000000-0000-4000-9853-${String(n).padStart(12, "0")}`;
const bytes = new TextEncoder().encode("trusted normalized source bytes");
const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
const start = Date.parse("2026-10-28T00:00:00Z");
function job(): EvidenceJob {
  return { id: uuid(1), reportId: uuid(2), sourceAttachmentId: uuid(3), generation: uuid(4), workToken: uuid(5),
    workExpiresAt: new Date(start + 300_000).toISOString(), expiresAt: new Date(start + 900_000).toISOString(),
    sourceBucket: "findback-chat-media", sourceObjectKey: `attachments/${uuid(6)}`,
    bucket: "findback-chat-moderation-evidence", objectKey: `evidence/${uuid(7)}`,
    sha256: sha, mime: "image/webp", bytes: bytes.length, width: 1280, height: 960 };
}
function stream(value: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(value.slice()); c.close(); } });
}
class MemoryCopy implements EvidenceCopyPorts {
  work: unknown = job();
  objects = new Map<string, Uint8Array>([[job().sourceObjectKey, bytes.slice()]]);
  events: string[] = [];
  finished: EvidenceJob[] = [];
  async claim(signal: AbortSignal) { signal.throwIfAborted(); this.events.push("claim"); return this.work; }
  async read(_bucket: string, key: string, signal: AbortSignal) {
    signal.throwIfAborted(); this.events.push(`read:${key}`);
    const value = this.objects.get(key); return value ? stream(value) : null;
  }
  async write(work: EvidenceJob, value: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted(); this.events.push("write");
    if (this.objects.has(work.objectKey)) throw new Error("immutable conflict");
    this.objects.set(work.objectKey, value.slice());
  }
  async finish(work: EvidenceJob, signal: AbortSignal) {
    signal.throwIfAborted(); this.events.push("finish"); this.finished.push(work);
  }
}

Deno.test("idle discovery performs no Storage operations", async () => {
  const io = new MemoryCopy(); io.work = null;
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "idle" });
  equal(io.events, ["claim"]);
});

Deno.test("verified immutable copy is read back before lease-aware finish", async () => {
  const io = new MemoryCopy();
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "attached" });
  equal(io.objects.get(job().objectKey), bytes);
  equal(io.events, ["claim", `read:${job().objectKey}`, `read:${job().sourceObjectKey}`, "write", `read:${job().objectKey}`, "finish"]);
  equal(io.finished, [job()]);
});

Deno.test("matching destination retries without source and never overwrites", async () => {
  const io = new MemoryCopy(); io.objects.clear(); io.objects.set(job().objectKey, bytes);
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "attached" });
  equal(io.events, ["claim", `read:${job().objectKey}`, "finish"]);
});

for (const corrupt of ["source", "destination"] as const) {
  Deno.test(`corrupt ${corrupt} never reaches finish`, async () => {
    const io = new MemoryCopy(); io.objects.set(corrupt === "source" ? job().sourceObjectKey : job().objectKey, new Uint8Array(bytes.length));
    equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" });
    equal(io.finished, []); ok(!io.events.includes("write"));
  });
}

Deno.test("lost upload response is reconciled only by exact destination read-back", async () => {
  const io = new MemoryCopy(); const write = io.write.bind(io);
  io.write = async (...args) => { await write(...args); throw new Error("lost response"); };
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "attached" });
  equal(io.finished.length, 1);
});

Deno.test("false upload success with wrong destination cannot attach", async () => {
  const io = new MemoryCopy(); io.write = async work => { io.objects.set(work.objectKey, new Uint8Array(bytes.length)); };
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" }); equal(io.finished, []);
});

Deno.test("overlong stream is cancelled before upload", async () => {
  const io = new MemoryCopy(); let cancelled = false;
  io.read = async (_bucket, key) => key === job().objectKey ? null : new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes.length + 1)); }, cancel() { cancelled = true; },
  });
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" });
  ok(cancelled); equal(io.finished, []); ok(!io.events.includes("write"));
});

Deno.test("short source is not copied", async () => {
  const io = new MemoryCopy(); io.objects.set(job().sourceObjectKey, bytes.slice(1));
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" }); equal(io.finished, []);
});

for (const patch of [{ sourceBucket: "public" }, { objectKey: "evidence/../other" }, { workToken: "" },
  { bytes: 20 * 1024 * 1024 + 1 }, { width: 0 }, { mime: "text/html" }, { workExpiresAt: "invalid" },
  { workExpiresAt: new Date(start + 4_999).toISOString() }]) {
  Deno.test(`malformed/expired work fails closed: ${Object.keys(patch).join()}`, async () => {
    const io = new MemoryCopy(); io.work = { ...job(), ...patch };
    equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" }); equal(io.events, ["claim"]);
  });
}

Deno.test("abort before claim does not discover work", async () => {
  const io = new MemoryCopy(); const c = new AbortController(); c.abort();
  equal(await copyOneChatEvidence(io, { now: () => start, signal: c.signal }), { status: "retry" }); equal(io.events, []);
});

Deno.test("cancellation interrupts a hanging port and prevents later upload/finish", async () => {
  const io = new MemoryCopy(); const c = new AbortController();
  io.read = async () => { c.abort(); return await new Promise(() => {}); };
  equal(await copyOneChatEvidence(io, { now: () => start, signal: c.signal }), { status: "retry" }); equal(io.finished, []);
});

Deno.test("deadline reached after upload prevents finish and leaves immutable bytes for retry", async () => {
  const io = new MemoryCopy(); let now = start; const write = io.write.bind(io);
  io.write = async (...args) => { await write(...args); now += 300_000; };
  equal(await copyOneChatEvidence(io, { now: () => now }), { status: "retry" });
  equal(io.objects.get(job().objectKey), bytes); equal(io.finished, []);
});

Deno.test("finish failure reports retry without exposing tokens, identities or Storage paths", async () => {
  const io = new MemoryCopy(); io.finish = async () => { throw new Error(JSON.stringify(job())); };
  equal(await copyOneChatEvidence(io, { now: () => start }), { status: "retry" });
});

Deno.test("successful finish remains attached when response crosses the local safety deadline", async () => {
  const io = new MemoryCopy(); let now = start; const finish = io.finish.bind(io);
  io.finish = async (...args) => { await finish(...args); now += 300_000; };
  equal(await copyOneChatEvidence(io, { now: () => now }), { status: "attached" });
  equal(io.finished.length, 1);
});
