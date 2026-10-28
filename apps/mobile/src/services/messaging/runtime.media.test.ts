// @vitest-environment node
/** Canonical runtime + session + platform IndexedDB storage + real SDK, fake
 * network only. Decoder replaced: no rendered/native/hosted acceptance claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseFunctionFetch } from "../supabaseClient";
import type { PlatformMessagingHandle } from "./platformHistory";
import { mediaFixture, deferred } from "./mediaTestDoubles";
import type { MediaMetadata } from "./media";
import type { MailboxEnvelope } from "./history";
import { listPendingMessagingDeletions } from "./scopedMediaBytes";

const boundary = vi.hoisted(() => ({ sdk: null as unknown, raw: null as unknown,
  handles: [] as PlatformMessagingHandle[], url: "https://runtime.example.test" }));
vi.mock("../supabaseClient", async (original) => ({ ...await original<typeof import("../supabaseClient")>(),
  getSupabase: () => boundary.sdk,
  getSupabaseBackendUrl: () => boundary.url,
  fetchSupabaseFunction: (...args: unknown[]) => (boundary.raw as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("./platformHistory", async (original) => {
  const real = await original<typeof import("./platformHistory")>();
  return { ...real, openPlatformMessagingHistory: async (...args: Parameters<typeof real.openPlatformMessagingHistory>) => {
    const handle = await real.openPlatformMessagingHistory(...args); boundary.handles.push(handle); return handle;
  } };
});
vi.mock("../media/webTranscode", () => ({ transcodeImageForWeb: async () => new Uint8Array(1) }));

// All identities and keys are synthetic test values, never credentials.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const A = id(1), B = id(2), DEVICE = id(3), CONV = id(4);
let runtime: typeof import("./runtime"), account: string, online: boolean, uploadFails: boolean;
let requestLog: string[], mail: MailboxEnvelope[], remote: Map<string, { metadata: MediaMetadata; bytes: ArrayBuffer }>;
let acked: Set<string>, deliveryGate: ReturnType<typeof deferred> | null, entered: ReturnType<typeof deferred>;
let lastGetSignal: AbortSignal | null;
let mutationGate: ReturnType<typeof deferred> | null, mutationEntered: ReturnType<typeof deferred>, connected: boolean;

async function waitForState(predicate: (state: ReturnType<typeof runtime.getMessagingRuntimeSnapshot>) => boolean) {
  if (predicate(runtime.getMessagingRuntimeSnapshot())) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error("runtime transition timed out")); }, 3000);
    const stop = runtime.subscribeMessagingRuntime(() => {
      if (predicate(runtime.getMessagingRuntimeSnapshot())) { clearTimeout(timeout); stop(); resolve(); }
    });
  });
}

beforeEach(async () => {
  vi.resetModules(); boundary.handles = []; account = A; online = true; uploadFails = false;
  requestLog = []; mail = []; remote = new Map(); acked = new Set(); deliveryGate = null;
  entered = deferred(); lastGetSignal = null;
  mutationGate = null; mutationEntered = deferred(); connected = true;
  const items = new Map<string, string>([["findback.messaging.installation.v1", DEVICE]]);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", { getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); } });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  const network: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!online) throw new Error("offline");
    if (request.url.includes("/rpc/")) {
      const args = await request.json() as Record<string, unknown>;
      expect(args.p_account_id).toBe(account); expect(args.p_device_id).toBe(DEVICE);
      if (request.url.endsWith("findback_fetch_chat_media_delivery")) {
        requestLog.push("delivery");
        return Response.json([...remote.values()].filter(({ metadata: m }) => !acked.has(m.id)).map(({ metadata: m }) => ({
          version: 1, attachmentId: m.id, messageId: m.messageId, sha256: m.sha256, mime: m.mime,
          bytes: m.byteSize, width: m.width, height: m.height, expiresAt: new Date(m.expiresAt!).toISOString(),
        })));
      }
      if (request.url.endsWith("findback_ack_chat_media_delivery")) {
        const key = args.p_attachment_id as string;
        requestLog.push(`media-ack:${key}`);
        const owner = [...boundary.handles].reverse().find((handle) => handle.scope.accountId === account)!;
        expect(await owner.history.readMedia(key)).toEqual(remote.get(key)!.bytes);
        acked.add(key); return new Response(null, { status: 204 });
      }
      const action = args.p_action as string, fields = args.p_args as Record<string, unknown>;
      requestLog.push(action);
      if (action === "REGISTER" || action === "STATE_ACK") return Response.json(null);
      if (action === "DELETE_FOR_ME" || action === "UNSEND") return Response.json(fields.messageId);
      if (action === "STATE_SYNC") return Response.json([]);
      if (action === "VIEWS") return Response.json([{ conversationId: CONV, peerId: account === A ? B : A,
        mode: connected ? "CONNECTED" : "REQUEST", request: "NONE", requestEpoch: null, ownBlocked: false,
        ownHidden: false, ownDeclined: false, revision: 1 }]);
      if (action === "END") {
        mutationEntered.resolve(); if (mutationGate) await mutationGate.promise;
        connected = false; return Response.json(null);
      }
      if (action === "SEND") {
        expect(fields.messageType).toBe("MEDIA");
        mail.push({ accountId: account, deviceId: DEVICE, mailboxId: id(400), event: { kind: "TEXT", eventId: id(300),
          sequence: 1, message: { id: fields.messageId as string, conversationId: CONV,
            authorId: account, recipientId: fields.recipientId as string, body: fields.body as string } } });
        return Response.json(fields.messageId);
      }
      if (action === "SYNC") return Response.json(mail);
      if (action === "ACK") { mail = mail.filter((row) => row.mailboxId !== fields.mailboxId); return Response.json(null); }
      throw new Error(`unexpected action ${action}`);
    }
    const key = request.headers.get("x-attachment-id")!;
    if (request.method === "GET") {
      requestLog.push(`GET:${key}`); lastGetSignal = init!.signal!;
      if (deliveryGate) { entered.resolve(); await deliveryGate.promise; }
      return new Response(remote.get(key)!.bytes.slice(0), { headers: { "content-type": "image/png" } });
    }
    requestLog.push(`POST:${key}`);
    if (uploadFails) return new Response(null, { status: 503 });
    const owner = [...boundary.handles].reverse().find((handle) => handle.scope.accountId === account)!;
    const row = (await owner.history.listMedia(CONV)).find((m) => m.id === key)!;
    expect((await owner.history.getMessage(row.messageId))?.server).toBeDefined();
    remote.set(key, { metadata: { ...row, expiresAt: Date.now() + 60_000 }, bytes: await request.arrayBuffer() });
    return Response.json({ attachmentId: key, sha256: row.sha256, mime: row.mime,
      bytes: row.byteSize, width: row.width, height: row.height });
  };
  const config = { url: boundary.url, key: "sb_publishable_synthetic_runtime" };
  boundary.sdk = createClient(config.url, config.key, { accessToken: async () => `synthetic-${account}`, global: { fetch: network } });
  boundary.raw = createSupabaseFunctionFetch(config, { getSession: async () => ({ data: {
    session: { user: { id: account }, access_token: `synthetic-${account}` } }, error: null }) }, network);
  runtime = await import("./runtime");
});
afterEach(async () => {
  runtime.clearMessagingRuntime(); deliveryGate?.resolve(); mutationGate?.resolve();
  await Promise.all(boundary.handles.map((handle) => handle.close()));
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("production messaging media owner", () => {
  it("purges captured A after switching to B without closing B or starting cleanup network work", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    await boundary.handles[0]!.history.enqueueOutgoing({ id: id(101), conversationId: CONV, authorId: A, recipientId: B, body: "private A" });
    runtime.setMessagingAccount(B); account = B;
    await waitForState((state) => state.accountId === B && state.status === "ready");
    const b = boundary.handles.at(-1)!;
    await b.history.enqueueOutgoing({ id: id(102), conversationId: CONV, authorId: B, recipientId: A, body: "private B" });
    const requests = [...requestLog];
    await runtime.purgeMessagingAccount(A);
    expect(runtime.getMessagingRuntimeSnapshot()).toMatchObject({ accountId: B, status: "ready" });
    expect((await runtime.readMessagingThread(B, CONV)).map((row) => row.body)).toEqual(["private B"]);
    expect(requestLog).toEqual(requests);
    expect(boundary.handles).toHaveLength(2);
    expect(await listPendingMessagingDeletions()).toEqual([]);
    runtime.setMessagingAccount(A); account = A;
    await waitForState((state) => state.accountId === A && state.status === "error");
    expect(boundary.handles).toHaveLength(2);
  });

  it("drains A's already pending platform close before cleanup and leaves replacement B alive", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const a = boundary.handles[0]!, close = a.close.bind(a), gate = deferred(), closing = deferred();
    vi.spyOn(a, "close").mockImplementation(async () => { closing.resolve(); await gate.promise; await close(); });
    runtime.setMessagingAccount(B); account = B; await closing.promise;
    let purging: Promise<void> | undefined;
    try {
      purging = runtime.purgeMessagingAccount(A);
      // Await independent fence persistence instead of sleeping or assuming a
      // launched purge has already been admitted durably.
      const { beginMessagingAccountDeletion } = await import("./scopedMediaBytes");
      await beginMessagingAccountDeletion(A);
      expect(await listPendingMessagingDeletions()).toEqual([A]);
      expect(boundary.handles).toHaveLength(1);
    } finally { gate.resolve(); }
    await purging;
    await waitForState((state) => state.accountId === B && state.status === "ready");
    expect(await runtime.readMessagingThread(B, CONV)).toEqual([]);
  });

  it("active deletion aborts a pending GET and prevents late byte persistence or ACK", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const inbound = await mediaFixture(id(202), id(102), { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(id(202), inbound);
    await boundary.handles[0]!.history.persistInbound({ accountId: A, deviceId: DEVICE, mailboxId: id(402),
      event: { kind: "TEXT", eventId: id(302), sequence: 2,
        message: { id: id(102), conversationId: CONV, authorId: B, recipientId: A, body: "" } } });
    deliveryGate = deferred(); const refresh = runtime.refreshMessaging(A);
    await entered.promise;
    const purge = runtime.purgeMessagingAccount(A);
    expect(runtime.getMessagingRuntimeSnapshot().accountId).toBeNull();
    expect(lastGetSignal?.aborted).toBe(true);
    await purge;
    deliveryGate.resolve(); await refresh;
    expect(requestLog).not.toContain(`media-ack:${id(202)}`);
    expect(await listPendingMessagingDeletions()).toEqual([]);
  });

  it("cannot restore stale receipt authority while end is pending during an older refresh", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const inbound = await mediaFixture(id(202), id(102), { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(id(202), inbound);
    await boundary.handles[0]!.history.persistInbound({ accountId: A, deviceId: DEVICE, mailboxId: id(402),
      event: { kind: "TEXT", eventId: id(302), sequence: 2,
        message: { id: id(102), conversationId: CONV, authorId: B, recipientId: A, body: "" } } });
    deliveryGate = deferred(); mutationGate = deferred(); const oldRefresh = runtime.refreshMessaging(A);
    await Promise.race([entered.promise, oldRefresh.then(() => { throw new Error("refresh completed without media GET"); })]);
    const ending = runtime.changeMessagingRelationship(A, CONV, "end");
    await mutationEntered.promise; await oldRefresh;
    try { expect(runtime.getMessagingRuntimeSnapshot().currentProjections).toBeNull(); }
    finally { deliveryGate.resolve(); mutationGate.resolve(); await ending; }
  });
  it("opens owned bytes, queues offline, then existing online wake reaches own-device READY", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    online = false;
    const fixture = await mediaFixture(id(201), id(101));
    expect(await runtime.sendMessagingMedia(A, CONV, B, "", fixture.metadata, fixture.bytes)).toBe(id(101));
    await waitForState((state) => state.status === "offline");
    expect((await runtime.readMessagingThreadState(A, CONV)).media[0]?.state).toBe("QUEUED");
    online = true; window.dispatchEvent(new Event("online"));
    await waitForState((state) => state.status === "ready");
    const state = await runtime.readMessagingThreadState(A, CONV);
    expect(state.messages[0]?.body).toBe(""); expect(state.outbox).toEqual([]);
    expect(state.media[0]?.state).toBe("READY");
    expect(await runtime.readMessagingMedia(A, id(201))).toEqual(fixture.bytes);
    expect(requestLog.indexOf("ACK")).toBeLessThan(requestLog.indexOf(`POST:${id(201)}`));
    expect(requestLog).toContain(`media-ack:${id(201)}`); expect(requestLog).not.toContain(`GET:${id(201)}`);
  });

  it("preserves local media on ordinary logout and same-account reopen", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const fixture = await mediaFixture(id(201), id(101));
    await runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes);
    await runtime.refreshMessaging(A);
    await waitForState((state) => state.status === "ready");
    runtime.clearMessagingRuntime(); runtime.setMessagingAccount(A);
    await waitForState((state) => state.status === "ready");
    expect((await runtime.readMessagingThreadState(A, CONV)).media[0]?.state).toBe("READY");
    expect(await runtime.readMessagingMedia(A, id(201))).toEqual(fixture.bytes);
  });

  it("removes an offline pending photo locally without a remote delete or unsend", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    online = false;
    const fixture = await mediaFixture(id(201), id(101));
    await runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes);
    await waitForState((state) => state.status === "offline");
    const requests = [...requestLog];
    await runtime.removeMessagingMessage(A, CONV, id(101), false);
    expect(await runtime.readMessagingThreadState(A, CONV)).toEqual({ messages: [], outbox: [], media: [] });
    expect(await runtime.readMessagingMedia(A, id(201))).toBeNull();
    expect(requestLog).toEqual(requests);
  });

  it("replays the exact stable IDs after durable admission committed but its return was lost", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    online = false;
    const fixture = await mediaFixture(id(201), id(101)), history = boundary.handles[0]!.history;
    const enqueue = history.enqueueOutgoingWithMedia.bind(history);
    vi.spyOn(history, "enqueueOutgoingWithMedia").mockImplementationOnce(async (...args) => {
      await enqueue(...args); throw new Error("synthetic lost completion");
    });
    await expect(runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes)).rejects.toThrow(/lost completion/);
    expect(await runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes)).toBe(id(101));
    const rows = await runtime.readMessagingThreadState(A, CONV);
    expect(rows.messages.map((row) => row.id)).toEqual([id(101)]);
    expect(rows.outbox.map((row) => row.messageId)).toEqual([id(101)]);
    expect(rows.media.map((row) => row.id)).toEqual([id(201)]);
    expect(await runtime.readMessagingMedia(A, id(201))).toEqual(fixture.bytes);
  });

  it("does not send a removed photo caption as plain text after its upload metadata disappeared", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    online = false;
    const fixture = await mediaFixture(id(201), id(101)), history = boundary.handles[0]!.history;
    await runtime.sendMessagingMedia(A, CONV, B, "private cancelled caption", fixture.metadata, fixture.bytes);
    await waitForState((state) => state.status === "offline");
    const list = history.listMedia.bind(history);
    vi.spyOn(history, "listMedia").mockImplementationOnce(async (...args) => {
      // Outbox has already been claimed. Canonical erasure wins before the
      // session discovers metadata, so it must not downgrade MEDIA to TEXT.
      await history.removeMediaForMessage(id(101));
      return list(...args);
    });
    online = true; await runtime.refreshMessaging(A);
    expect(requestLog).not.toContain("SEND");
    expect(await runtime.readMessagingThreadState(A, CONV)).toEqual({ messages: [], outbox: [], media: [] });
  });

  it("rejects local cancellation if a server echo wins after the session's initial read", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    online = false;
    const fixture = await mediaFixture(id(201), id(101)), history = boundary.handles[0]!.history;
    await runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes);
    await waitForState((state) => state.status === "offline");
    const remove = history.removeMediaForMessage.bind(history);
    vi.spyOn(history, "removeMediaForMessage").mockImplementationOnce(async (...args) => {
      await history.persistInbound({ accountId: A, deviceId: DEVICE, mailboxId: id(401), event: { kind: "TEXT",
        eventId: id(301), sequence: 1, message: { id: id(101), conversationId: CONV, authorId: A, recipientId: B, body: "caption" } } });
      await remove(...args);
    });
    await expect(runtime.removeMessagingMessage(A, CONV, id(101), false)).rejects.toThrow(/pending/i);
    expect((await runtime.readMessagingThreadState(A, CONV)).messages[0]?.server?.sequence).toBe(1);
    expect(await runtime.readMessagingMedia(A, id(201))).toEqual(fixture.bytes);
    expect(requestLog).not.toContain("DELETE_FOR_ME");
  });

  it("keeps echoed deletion on the remote state-sync path rather than silently applying local-only erasure", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const fixture = await mediaFixture(id(201), id(101));
    await runtime.sendMessagingMedia(A, CONV, B, "caption", fixture.metadata, fixture.bytes);
    await runtime.refreshMessaging(A); await waitForState((state) => state.status === "ready");
    const start = requestLog.length;
    await runtime.removeMessagingMessage(A, CONV, id(101), false);
    expect(requestLog.slice(start)).toContain("DELETE_FOR_ME");
    expect(requestLog.slice(start)).toContain("STATE_SYNC");
    // This synthetic server has not supplied the deletion state envelope yet.
    // Do not pretend a mutation HTTP result is the durable erasure event.
    expect((await runtime.readMessagingThreadState(A, CONV)).messages[0]?.body).toBe("caption");
  });

  it("receives incoming media despite outgoing POST failure", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const inbound = await mediaFixture(id(202), id(102), { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(id(202), inbound);
    await boundary.handles[0]!.history.persistInbound({ accountId: A, deviceId: DEVICE, mailboxId: id(402),
      event: { kind: "TEXT", eventId: id(302), sequence: 2,
        message: { id: id(102), conversationId: CONV, authorId: B, recipientId: A, body: "" } } });
    uploadFails = true;
    const outgoing = await mediaFixture(id(201), id(101));
    await runtime.sendMessagingMedia(A, CONV, B, "", outgoing.metadata, outgoing.bytes);
    await runtime.refreshMessaging(A); await waitForState((state) => state.status === "ready");
    expect((await runtime.readMessagingThreadState(A, CONV)).media.map((row) => row.state)).toEqual(["FAILED", "READY"]);
    expect(runtime.getMessagingRuntimeSnapshot().error).toMatch(/photo/i);
  });

  it("switches A to B during GET without late A persistence, ACK or B contamination", async () => {
    runtime.setMessagingAccount(A); await waitForState((state) => state.status === "ready");
    const inbound = await mediaFixture(id(202), id(102), { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(id(202), inbound);
    await boundary.handles[0]!.history.persistInbound({ accountId: A, deviceId: DEVICE, mailboxId: id(402),
      event: { kind: "TEXT", eventId: id(302), sequence: 2,
        message: { id: id(102), conversationId: CONV, authorId: B, recipientId: A, body: "" } } });
    deliveryGate = deferred(); const pending = runtime.refreshMessaging(A);
    await Promise.race([entered.promise, pending.then(() => { throw new Error("refresh completed without media GET"); })]);
    runtime.setMessagingAccount(B); account = B;
    expect(lastGetSignal?.aborted).toBe(true);
    deliveryGate.resolve(); await pending;
    await waitForState((state) => state.accountId === B && state.status === "ready");
    expect((await runtime.readMessagingThreadState(B, CONV)).media).toEqual([]);
    expect(requestLog).not.toContain(`media-ack:${id(202)}`);
    account = A; runtime.setMessagingAccount(A); remote.clear();
    await waitForState((state) => state.accountId === A && state.status === "ready");
    expect((await runtime.readMessagingThreadState(A, CONV)).media).toEqual([]);
  });
});
