import type { MessagingScope } from "./history";
import { copyMediaMetadata, type MediaMetadata } from "./media";
import { verifyMediaContainer } from "./mediaContent";
import { uuid } from "./validation";

export interface MediaTransportPorts {
  request(input: { method: "GET" | "POST"; headers: Record<string, string>; body?: ArrayBuffer;
    signal: AbortSignal }): Promise<Response>;
  rpc(input: { name: "findback_fetch_chat_media_delivery" | "findback_ack_chat_media_delivery";
    args: Record<string, string>; signal: AbortSignal }): Promise<unknown>;
}
export type MediaDelivery = Omit<MediaMetadata, "direction" | "expiresAt"> & { expiresAt: number };

const unavailable = () => new Error("Photo could not sync. Try again.");
const assertLive = (signal: AbortSignal) => { if (signal.aborted) throw unavailable(); };
const cancelBody = (response: Response) => { void response.body?.cancel().catch(() => undefined); };

/** A non-cooperating promise cannot keep an aborted/deadline-expired attempt alive. */
function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(pending).then(
      (value) => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(unavailable()); else resolve(value); },
      () => { signal.removeEventListener("abort", abort); reject(unavailable()); },
    );
    if (signal.aborted) abort();
  });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw unavailable();
  return value as Record<string, unknown>;
}
const UPLOAD_FIELDS = ["attachmentId", "sha256", "mime", "bytes", "width", "height"];
const DELIVERY_FIELDS = ["version", ...UPLOAD_FIELDS, "messageId", "expiresAt"];

/** Buffer at most the independently validated bound, including an EOF sentinel. */
async function readBody(response: Response, maximum: number, exact: boolean, signal: AbortSignal): Promise<ArrayBuffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))
    || Number(length) > maximum || (exact && Number(length) !== maximum))) {
    cancelBody(response); throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), bytes = new Uint8Array(maximum);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let total = 0, ended = false;
  try {
    while (true) {
      assertLive(signal);
      const next = await abortable(reader.read(), signal);
      assertLive(signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > maximum - total) throw unavailable();
      bytes.set(next.value, total); total += next.value.byteLength;
    }
    if ((exact && total !== maximum) || (length !== null && total !== Number(length))) throw unavailable();
    return total === maximum ? bytes.buffer : bytes.buffer.slice(0, total);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!ended) cancel();
    reader.releaseLock();
  }
}

/** No storage writes or READY transition here; adapters alone own persistence/ACK. */
export function createMediaTransport(inputScope: MessagingScope, owner: AbortSignal, ports: MediaTransportPorts) {
  const scope = { accountId: uuid(inputScope.accountId), deviceId: uuid(inputScope.deviceId) };
  const attempt = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertLive(owner);
    const controller = new AbortController();
    const abort = () => controller.abort();
    owner.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 90_000);
    try {
      const result = await abortable(work(controller.signal), controller.signal);
      assertLive(controller.signal); return result;
    } catch { throw unavailable(); }
    finally { clearTimeout(timeout); owner.removeEventListener("abort", abort); }
  };
  const request = async (input: Parameters<MediaTransportPorts["request"]>[0], type: string, maximum: number, exact: boolean) => {
    assertLive(input.signal);
    let received: Response | undefined;
    // Own the body across the promise-to-reader handoff too. A stream can start
    // pulling before readBody acquires its reader, and closure may land there.
    const abort = () => { if (received && !received.body?.locked) cancelBody(received); };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const pending = ports.request(input).then((response) => {
        received = response;
        if (input.signal.aborted) { cancelBody(response); throw unavailable(); }
        return response;
      });
      const response = await abortable(pending, input.signal);
      if (response.status !== 200 || response.redirected || response.type === "opaque"
        || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== type) {
        cancelBody(response); throw unavailable();
      }
      return await readBody(response, maximum, exact, input.signal);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  };
  const rpc = (name: Parameters<MediaTransportPorts["rpc"]>[0]["name"], args: Record<string, string>, signal: AbortSignal) => {
    assertLive(signal);
    return abortable(ports.rpc({ name, args: { p_account_id: scope.accountId, p_device_id: scope.deviceId, ...args }, signal }), signal);
  };
  return {
    upload(input: MediaMetadata, inputBytes: ArrayBuffer): Promise<void> {
      return attempt(async (signal) => {
        const metadata = copyMediaMetadata(input);
        if (metadata.direction !== "OUT" || !(inputBytes instanceof ArrayBuffer)
          || inputBytes.byteLength !== metadata.byteSize) throw unavailable();
        const bytes = inputBytes.slice(0);
        await abortable(verifyMediaContainer(metadata, bytes), signal);
        const raw = await request({ method: "POST", headers: { "content-type": metadata.mime,
          "x-attachment-id": metadata.id, "x-message-id": metadata.messageId }, body: bytes, signal }, "application/json", 4096, false);
        const result = exactObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), UPLOAD_FIELDS);
        if (result.attachmentId !== metadata.id || result.sha256 !== metadata.sha256 || result.mime !== metadata.mime
          || result.bytes !== metadata.byteSize || result.width !== metadata.width || result.height !== metadata.height) throw unavailable();
      });
    },
    download(input: MediaMetadata): Promise<ArrayBuffer> {
      return attempt(async (signal) => {
        const metadata = copyMediaMetadata(input);
        if (metadata.expiresAt === null || metadata.expiresAt <= Date.now()) throw unavailable();
        const bytes = await request({ method: "GET", headers: { "x-attachment-id": metadata.id }, signal }, metadata.mime, metadata.byteSize, true);
        await abortable(verifyMediaContainer(metadata, bytes), signal);
        if (metadata.expiresAt <= Date.now()) throw unavailable();
        return bytes;
      });
    },
    fetchDeliveries(): Promise<MediaDelivery[]> {
      return attempt(async (signal) => {
        const value = await rpc("findback_fetch_chat_media_delivery", {}, signal);
        if (!Array.isArray(value) || value.length > 100) throw unavailable();
        const attachments = new Set<string>(), messages = new Set<string>();
        return value.map((entry) => {
          const row = exactObject(entry, DELIVERY_FIELDS);
          if (row.version !== 1 || typeof row.expiresAt !== "string"
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.expiresAt)) throw unavailable();
          const expiresAt = Date.parse(row.expiresAt);
          const metadata = copyMediaMetadata({ id: row.attachmentId, messageId: row.messageId, direction: "IN",
            sha256: row.sha256, mime: row.mime, byteSize: row.bytes, width: row.width, height: row.height, expiresAt });
          if (expiresAt <= Date.now() || attachments.has(metadata.id) || messages.has(metadata.messageId)) throw unavailable();
          attachments.add(metadata.id); messages.add(metadata.messageId);
          // Direction is deliberately absent: session must resolve the durable parent.
          return { id: metadata.id, messageId: metadata.messageId, sha256: metadata.sha256, mime: metadata.mime,
            byteSize: metadata.byteSize, width: metadata.width, height: metadata.height, expiresAt };
        });
      });
    },
    ack(attachmentId: string): Promise<void> {
      return attempt(async (signal) => {
        const result = await rpc("findback_ack_chat_media_delivery", { p_attachment_id: uuid(attachmentId) }, signal);
        if (result !== null && result !== undefined) throw unavailable();
      });
    },
  };
}
