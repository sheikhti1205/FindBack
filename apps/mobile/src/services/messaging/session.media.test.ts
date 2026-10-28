// @vitest-environment node
/** Real metadata adapters + IndexedDB bytes + bounded transport. Synthetic images
 * use an injected decoder; this is not browser/native decoder acceptance. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanMessage, MailboxEnvelope, MessagingHistory } from "./history";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import { openMediaBytes, type MediaBytesStore } from "./mediaBytes";
import { createMediaTransport, type MediaTransportPorts } from "./mediaTransport";
import { createMessagingSession, type MessagingRpc } from "./session";
import { deferred, mediaFixture } from "./mediaTestDoubles";
import type { MediaMetadata } from "./media";
import type { ConversationProjection } from "./conversationIndex";

// Synthetic identities, never deployed account records or credentials.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const A = id(1), B = id(2), DEVICE = id(3), CONV = id(4);
const scope = { accountId: A, deviceId: DEVICE };
const message = (n = 1, body = ""): HumanMessage => ({ id: id(100 + n), conversationId: CONV,
  authorId: A, recipientId: B, body });
const projection: ConversationProjection = { conversationId: CONV, peerId: B, mode: "CONNECTED",
  request: "NONE", requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 };
const envelope = (value: HumanMessage, n = 1): MailboxEnvelope => ({ ...scope, mailboxId: id(400 + n),
  event: { kind: "TEXT", eventId: id(300 + n), sequence: n, message: value } });

describe.each(["sqlite", "web"] as const)("%s canonical media session", (backend) => {
  let factory: IDBFactory, bytes: MediaBytesStore, directory: string;
  let histories: MessagingHistory[], sessions: ReturnType<typeof createMessagingSession>[];
  let mailbox: MailboxEnvelope[], view: ConversationProjection;
  let sendError: boolean, uploadError: boolean, lostUpload: boolean, lostAck: boolean;
  let downloads: string[], uploads: string[], acks: string[], sends: Record<string, unknown>[], fetches: number;
  let remote: Map<string, { metadata: MediaMetadata; bytes: ArrayBuffer }>, acknowledged: Set<string>;

  beforeEach(async () => {
    factory = new IDBFactory(); histories = []; sessions = []; mailbox = []; view = { ...projection };
    sendError = uploadError = lostUpload = lostAck = false;
    downloads = []; uploads = []; acks = []; sends = []; fetches = 0;
    remote = new Map(); acknowledged = new Set();
    directory = mkdtempSync("/tmp/opencode/session-media-"); // recomputable per-command databases only
    bytes = await openMediaBytes({ indexedDB: factory, databaseName: "session-media" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sessions.map((session) => session.close()));
    await Promise.all(histories.map((history) => history.close()));
    await bytes.close(); rmSync(directory, { recursive: true, force: true });
  });

  async function open() {
    const options = { mediaBytes: bytes, decodeMedia: async () => undefined };
    let history: MessagingHistory;
    if (backend === "web") history = await openWebMessagingHistory(scope, { ...options, indexedDB: factory });
    else {
      const db = new DatabaseSync(join(directory, "history.db"));
      history = await openSqliteMessagingHistory({
        exec: async (sql) => { await Promise.resolve(); db.exec(sql); },
        all: async <T>(sql: string, params: readonly (string | number | null)[] = []) => {
          await Promise.resolve(); return db.prepare(sql).all(...params) as T[];
        },
        run: async (sql, params = []) => { await Promise.resolve(); return Number(db.prepare(sql).run(...params).changes); },
        close: async () => { db.close(); },
      }, scope, options);
    }
    histories.push(history); await history.cacheConversation(view); return history;
  }

  // Reproduce a pre-discriminator queued record without fabricating a message
  // classification from its caption. Both real stores keep this state durably.
  async function forgetQueuedClassification(messageId: string) {
    if (backend === "sqlite") {
      const db = new DatabaseSync(join(directory, "history.db"));
      try { db.prepare("update messages set message_type=null where id=?").run(messageId); }
      finally { db.close(); }
    } else {
      const request = factory.open(`findback-human-history-v1:${A}:${DEVICE}`);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("messages", "readwrite"), store = tx.objectStore("messages");
          const read = store.get(messageId);
          read.onsuccess = () => { const { messageType: _type, ...legacy } = read.result as HumanMessage; store.put(legacy); };
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    }
  }
  const rpc: MessagingRpc = async ({ accountId, deviceId, action, args, signal }) => {
    expect({ accountId, deviceId }).toEqual(scope); expect(signal.aborted).toBe(false);
    if (action === "SEND") {
      sends.push(args); if (sendError) throw new Error("offline");
      const value = { id: args.messageId, conversationId: args.conversationId, authorId: A,
        recipientId: args.recipientId, body: args.body, messageType: args.messageType } as HumanMessage;
      mailbox = [envelope(value, sends.length)]; return value.id;
    }
    if (action === "ACK") { mailbox = mailbox.filter((row) => row.mailboxId !== args.mailboxId); return null; }
    if (action === "SYNC") return [...mailbox];
    if (action === "STATE_SYNC") return [];
    if (action === "VIEWS") return [view];
    if (action === "END") { view = { ...view, mode: "REQUEST", revision: view.revision + 1 }; return null; }
    if (action === "BLOCK") { view = { ...view, ownBlocked: true, revision: view.revision + 1 }; return null; }
    return null;
  };
  function network(history: MessagingHistory): MediaTransportPorts {
    return {
      request: async ({ method, headers, body, signal }) => {
        expect(signal.aborted).toBe(false);
        const key = headers["x-attachment-id"]!;
        if (method === "GET") {
          downloads.push(key); const value = remote.get(key)!;
          return new Response(value.bytes.slice(0), { headers: { "content-type": value.metadata.mime } });
        }
        uploads.push(key);
        // Mutating production to POST before durable echo fails here.
        expect((await history.getMessage(headers["x-message-id"]!))?.server?.sequence).toBe(1);
        const local = (await history.listMedia(CONV)).find((row) => row.id === key)!;
        expect(local.state).toBe("UPLOADING"); expect(body).toEqual(await bytes.get(A, key));
        if (uploadError) return new Response(null, { status: 503 });
        const metadata = { ...local, expiresAt: Date.now() + 60_000 };
        remote.set(key, { metadata, bytes: body!.slice(0) });
        if (lostUpload) return new Response(null, { status: 503 });
        return Response.json({ attachmentId: key, sha256: metadata.sha256, mime: metadata.mime,
          bytes: metadata.byteSize, width: metadata.width, height: metadata.height });
      },
      rpc: async ({ name, args, signal }) => {
        expect(signal.aborted).toBe(false);
        expect(args.p_account_id).toBe(A); expect(args.p_device_id).toBe(DEVICE);
        if (name === "findback_fetch_chat_media_delivery") {
          fetches++;
          return [...remote.values()].filter(({ metadata }) => !acknowledged.has(metadata.id)).slice(0, 100)
            .map(({ metadata: m }) => ({ version: 1, attachmentId: m.id, messageId: m.messageId,
              sha256: m.sha256, mime: m.mime, bytes: m.byteSize, width: m.width, height: m.height,
              expiresAt: new Date(m.expiresAt!).toISOString() }));
        }
        const key = args.p_attachment_id!; acks.push(key);
        // Mutating production to ACK a fetched/in-memory copy fails these reads.
        expect((await history.listMedia(CONV)).find((row) => row.id === key)?.state).toBe("AWAITING_ACK");
        expect(await history.readMedia(key)).toEqual(remote.get(key)!.bytes);
        acknowledged.add(key);
        if (lostAck) throw new Error("lost ACK reply");
        return null;
      },
    };
  }
  function session(history: MessagingHistory, ports = network(history)) {
    const result = createMessagingSession(scope, history, rpc,
      (identity, signal) => createMediaTransport(identity, signal, ports));
    sessions.push(result); return result;
  }
  async function incoming(history: MessagingHistory, n = 2) {
    const value = { ...message(n), authorId: B, recipientId: A };
    await history.persistInbound(envelope(value, n));
    const fixture = await mediaFixture(id(200 + n), value.id, { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(fixture.metadata.id, fixture); return fixture;
  }

  it.each(["", "A photo caption"])("sends durable attachment caption %j as MEDIA and persists its echo", async (caption) => {
    const history = await open(), client = session(history), value = message(1, caption);
    const fixture = await mediaFixture(id(201), value.id);
    await history.enqueueOutgoingWithMedia(value, fixture.metadata, fixture.bytes);
    await client.flush();
    expect(sends).toEqual([{ conversationId: CONV, recipientId: B, messageId: value.id, body: caption, messageType: "MEDIA" }]);
    expect(await history.getMessage(value.id)).toMatchObject({ messageType: "MEDIA", server: { sequence: 1 } });
    expect(await history.listOutbox()).toEqual([]);
    expect((await history.listMedia(CONV))[0]?.state).toBe("QUEUED");
  });

  it("does not downgrade a classified caption to TEXT when attachment discovery is missing", async () => {
    const history = await open(), client = session(history), value = message(1, "Caption");
    const fixture = await mediaFixture(id(201), value.id);
    await history.enqueueOutgoingWithMedia(value, fixture.metadata, fixture.bytes);
    vi.spyOn(history, "listMedia").mockResolvedValue([]);
    await expect(client.flush()).rejects.toThrow();
    expect(sends).toEqual([]);
    expect(await history.getMessage(value.id)).toMatchObject({ messageType: "MEDIA" });
  });

  it("quarantines a legacy unknown send across repeated flushes without starving newer messages; explicit text admission recovers it", async () => {
    const initial = await open(), legacy = message(1, "Old caption");
    await initial.enqueueOutgoing(legacy);
    await forgetQueuedClassification(legacy.id);
    await initial.close();
    const history = await open(), client = session(history);
    await history.enqueueOutgoing(message(2, "New text"));
    await client.flush(); await client.flush(); await client.flush();
    expect(sends.map((args) => args.messageId)).toEqual([message(2).id]);
    expect(await history.listOutbox()).toEqual([{ messageId: legacy.id, status: "NEEDS_REVIEW", attempts: 0 }]);
    expect((await history.getMessage(legacy.id))?.messageType).toBeUndefined();

    // Only an explicit user text admission, not a wake/retry, may classify this
    // unsent record. Existing immutable identity/body must still match.
    await expect(client.send({ ...legacy, body: "Changed" })).rejects.toThrow(/conflict/i);
    await client.send(legacy);
    expect((await history.getMessage(legacy.id))?.messageType).toBe("TEXT");
    await client.flush();
    expect(sends.map((args) => args.messageId)).toEqual([message(2).id, legacy.id]);
    expect(await history.listOutbox()).toEqual([]);
  });

  it("recovers a quarantined send only through explicit verified media admission when the user chooses a photo", async () => {
    const history = await open(), client = session(history), legacy = message(1, "Old caption");
    await history.enqueueOutgoing(legacy);
    await forgetQueuedClassification(legacy.id);
    const fixture = await mediaFixture(id(201), legacy.id);
    await client.sendMedia(legacy, fixture.metadata, fixture.bytes);
    expect((await history.getMessage(legacy.id))?.messageType).toBe("MEDIA");
    await client.flush();
    expect(sends).toEqual([{ conversationId: CONV, recipientId: B, messageId: legacy.id, body: legacy.body, messageType: "MEDIA" }]);
    expect(await history.listOutbox()).toEqual([]);
  });

  it("reconciles a legacy unknown outbox from authority before any resend", async () => {
    const history = await open(), client = session(history), legacy = message(1, "Old caption");
    await history.enqueueOutgoing(legacy);
    await forgetQueuedClassification(legacy.id);
    await client.flush();
    expect(sends).toEqual([]);
    mailbox = [envelope({ ...legacy, messageType: "TEXT" })];
    await client.sync(); await client.flush();
    expect(sends).toEqual([]);
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.getMessage(legacy.id)).toMatchObject({ messageType: "TEXT", server: { sequence: 1 } });
  });

  it("retains unknown legacy classification until an authoritative echo supplies it, without downgrade", async () => {
    const history = await open(), client = session(history), value = { ...message(1, "Caption"), authorId: B, recipientId: A };
    mailbox = [envelope(value)];
    await client.sync();
    expect((await history.getMessage(value.id))?.messageType).toBeUndefined();
    mailbox = [envelope({ ...value, messageType: "MEDIA" })];
    await client.sync();
    expect((await history.getMessage(value.id))?.messageType).toBe("MEDIA");
    mailbox = [envelope(value)];
    await client.sync();
    expect((await history.getMessage(value.id))?.messageType).toBe("MEDIA");
    mailbox = [envelope({ ...value, messageType: "TEXT" })];
    await expect(client.sync()).rejects.toThrow(/conflict/i);
    expect(mailbox).toHaveLength(1); // No ACK for contradictory classification.
    expect((await history.getMessage(value.id))?.messageType).toBe("MEDIA");
  });

  it("refuses attachment delivery under an authoritative TEXT parent before bytes or ACK", async () => {
    const history = await open(), client = session(history);
    const value = { ...message(1, "Not a photo"), authorId: B, recipientId: A, messageType: "TEXT" as const };
    await history.persistInbound(envelope(value));
    const fixture = await mediaFixture(id(201), value.id, { direction: "IN", expiresAt: Date.now() + 60_000 });
    remote.set(fixture.metadata.id, fixture);
    await expect(client.syncMedia()).rejects.toThrow();
    expect(acks).toEqual([]);
    expect(await bytes.get(A, fixture.metadata.id)).toBeNull();
    expect(await history.listMedia(CONV)).toEqual([]);
  });

  it("rejects a classification conflict even after unsend erased the body", async () => {
    const history = await open();
    const value = { ...message(1, "Caption"), authorId: B, recipientId: A, messageType: "MEDIA" as const };
    await history.persistInbound(envelope(value));
    await history.applyStateChange({ ...scope,
      change: { kind: "UNSEND", eventId: id(600), sequence: 1, conversationId: CONV, messageId: value.id, authorId: B,
        recipientId: A, messageSequence: 1, occurredAt: Date.now() } });
    await expect(history.persistInbound(envelope({ ...value, messageType: "TEXT" }))).rejects.toThrow(/conflict/i);
    expect(await history.getMessage(value.id)).toMatchObject({ messageType: "MEDIA", body: "" });
  });

  it.each([null, "", "VIDEO", "text", 1, {}])("rejects malformed mailbox classification %j before persistence or ACK", async (messageType) => {
    const history = await open(), client = session(history);
    const value = { ...message(1, "Caption"), authorId: B, recipientId: A, messageType } as HumanMessage;
    mailbox = [envelope(value)];
    await expect(client.sync()).rejects.toThrow(/type/i);
    expect(mailbox).toHaveLength(1);
    expect(await history.getMessage(value.id)).toBeNull();
    expect(await history.listMessages(CONV)).toEqual([]);
  });

  it("accepts authorized image-only inbound echo without permitting empty plain-text sends", async () => {
    const history = await open(), client = session(history);
    await expect(client.send(message())).rejects.toThrow();
    mailbox = [envelope({ ...message(), authorId: B, recipientId: A, messageType: "MEDIA" } as HumanMessage)];
    expect(await client.sync()).toBe(1);
    expect(await history.getMessage(message().id)).toMatchObject({ body: "", messageType: "MEDIA", server: { sequence: 1 } });
  });

  it("queues a photo offline, reopens, uploads after echo and ACKs own-device bytes before READY", async () => {
    let history = await open(), client = session(history);
    const fixture = await mediaFixture(id(201), message().id);
    await client.sendMedia(message(), fixture.metadata, fixture.bytes);
    await client.close(); history = await open(); client = session(history);
    await client.flushMedia(); expect(uploads).toEqual([]); // no echo yet
    await client.flush(); await client.flushMedia();
    expect((await history.listMedia(CONV))[0]).toMatchObject({ state: "AWAITING_ACK", expiresAt: null });
    expect(acks).toEqual([]);
    await client.syncMedia();
    expect((await history.listMedia(CONV))[0]).toMatchObject({ state: "READY", direction: "OUT" });
    expect(downloads).toEqual([]); expect(acks).toEqual([id(201)]);
  });

  it("does not accept caller-invented expiry as trusted delivery metadata", async () => {
    const history = await open(), client = session(history);
    const fixture = await mediaFixture(id(201), message().id, { expiresAt: Date.now() + 60_000 });
    await expect(client.sendMedia(message(), fixture.metadata, fixture.bytes)).rejects.toThrow();
    expect(await history.listOutbox()).toEqual([]); expect(await bytes.keys(A)).toEqual([]);
  });

  it("recovers a committed upload with lost reply by discovery without uploading again", async () => {
    const history = await open(), client = session(history), fixture = await mediaFixture(id(201), message().id);
    await client.sendMedia(message(), fixture.metadata, fixture.bytes); await client.flush(); lostUpload = true;
    await expect(client.flushMedia()).rejects.toThrow();
    expect((await history.listMedia(CONV))[0]?.state).toBe("FAILED");
    await client.syncMedia();
    expect((await history.listMedia(CONV))[0]?.state).toBe("READY"); expect(uploads).toEqual([id(201)]);
  });

  it("retries stable failed upload once per wake while receiving unrelated inbound photos", async () => {
    const history = await open(), client = session(history), fixture = await mediaFixture(id(201), message().id);
    await client.sendMedia(message(), fixture.metadata, fixture.bytes); await client.flush();
    await incoming(history); uploadError = true;
    await expect(client.flushMedia()).rejects.toThrow(); await client.syncMedia();
    expect(uploads).toEqual([id(201)]); expect(acks).toEqual([id(202)]);
    uploadError = false; await client.flushMedia(); await client.syncMedia();
    expect(uploads).toEqual([id(201), id(201)]);
    expect((await history.listMedia(CONV)).map((row) => row.state)).toEqual(["READY", "READY"]);
  });

  it("recovers local AWAITING_ACK after remote ACK succeeded but its reply was lost", async () => {
    let history = await open(), client = session(history);
    await incoming(history); lostAck = true;
    await expect(client.syncMedia()).rejects.toThrow();
    expect((await history.listMedia(CONV))[0]?.state).toBe("AWAITING_ACK");
    expect(acknowledged.has(id(202))).toBe(true);
    await client.close(); history = await open(); client = session(history); lostAck = false;
    await client.syncMedia();
    expect((await history.listMedia(CONV))[0]?.state).toBe("READY");
    expect(acks).toEqual([id(202), id(202)]); expect(downloads).toEqual([id(202)]);
  });

  it("stops a full absent-parent page without ACK, byte write or unbounded refetch", async () => {
    const history = await open(), client = session(history);
    const fixture = await mediaFixture(id(201), message().id, { expiresAt: Date.now() + 60_000 });
    for (let n = 1; n <= 100; n++) remote.set(id(200 + n), { ...fixture,
      metadata: { ...fixture.metadata, id: id(200 + n), messageId: id(100 + n) } });
    await client.syncMedia();
    expect(fetches).toBe(1); expect(acks).toEqual([]); expect(downloads).toEqual([]);
    expect(await bytes.keys(A)).toEqual([]);
  });

  it("redownloads evicted bytes by retained identity without discovery", async () => {
    const history = await open(), client = session(history), fixture = await incoming(history);
    await client.syncMedia(); await history.evictMedia(1);
    const priorFetches = fetches;
    await client.downloadMedia(CONV, fixture.metadata.id);
    expect(fetches).toBe(priorFetches); expect(downloads).toEqual([id(202), id(202)]);
    expect(await history.readMedia(id(202))).toEqual(fixture.bytes);
    expect((await history.listMedia(CONV))[0]?.state).toBe("READY");
  });

  it.each([404, 503])("propagates explicit redownload HTTP%s without persisting or ACKing missing bytes", async (status) => {
    const history = await open(), ports = network(history), client = session(history, ports), fixture = await incoming(history);
    await client.syncMedia(); await history.evictMedia(1);
    const priorAcks = [...acks];
    ports.request = async () => new Response(null, { status });
    await expect(client.downloadMedia(CONV, fixture.metadata.id)).rejects.toMatchObject({ name: status === 404 ? "PhotoUnavailableError" : "Error" });
    expect(await history.readMedia(fixture.metadata.id)).toBeNull();
    expect((await history.listMedia(CONV))[0]?.state).toBe("EVICTED");
    expect(acks).toEqual(priorAcks);
  });

  it("propagates trusted local expiry without another GET or ACK", async () => {
    const history = await open(), client = session(history), fixture = await incoming(history);
    await client.syncMedia(); await history.evictMedia(1);
    const priorDownloads = [...downloads], priorAcks = [...acks];
    vi.spyOn(Date, "now").mockReturnValue(fixture.metadata.expiresAt! + 1);
    await expect(client.downloadMedia(CONV, fixture.metadata.id)).rejects.toMatchObject({ name: "PhotoUnavailableError" });
    expect(downloads).toEqual(priorDownloads); expect(acks).toEqual(priorAcks);
  });

  it("drains a full acknowledged page to reach later deliveries", async () => {
    const history = await open(), client = session(history);
    for (let n = 1; n <= 101; n++) await incoming(history, n);
    await client.syncMedia();
    expect(fetches).toBe(2); expect(acknowledged.size).toBe(101);
    expect((await history.listMedia(CONV)).every((row) => row.state === "READY")).toBe(true);
  });

  it("defers suppressed parents and never revives media erased while GET is pending", async () => {
    const history = await open(), fixture = await incoming(history), ports = network(history);
    const entered = deferred(), release = deferred();
    ports.request = async () => { entered.resolve(); await release.promise;
      return new Response(fixture.bytes, { headers: { "content-type": "image/png" } }); };
    const client = session(history, ports), pending = Promise.allSettled([client.syncMedia()]);
    await entered.promise;
    await history.removeMediaForMessage(fixture.metadata.messageId);
    release.resolve(); expect((await pending)[0]?.status).toBe("rejected");
    await client.syncMedia();
    expect(acks).toEqual([]); expect(await bytes.keys(A)).toEqual([]);
    expect(await history.listMedia(CONV)).toEqual([]);
  });

  it("continues the delivery page after corrupt bytes without ACKing the invalid object", async () => {
    const history = await open(), client = session(history);
    const invalid = await incoming(history, 1); await incoming(history, 2);
    remote.set(id(201), { ...invalid, bytes: new ArrayBuffer(64) });
    await expect(client.syncMedia()).rejects.toThrow();
    expect(acks).toEqual([id(202)]); expect(await bytes.keys(A)).toEqual([id(202)]);
    expect((await history.listMedia(CONV)).map((row) => row.id)).toEqual([id(202)]);
  });

  it("aborts a pending download on close and cannot ACK or persist a late response", async () => {
    const history = await open(), fixture = await incoming(history), ports = network(history);
    const entered = deferred(), release = deferred(); let signal: AbortSignal | undefined;
    ports.request = async (input) => { signal = input.signal; entered.resolve(); await release.promise;
      return new Response(fixture.bytes, { headers: { "content-type": "image/png" } }); };
    const client = session(history, ports), pending = Promise.allSettled([client.syncMedia()]);
    await entered.promise; await client.close(); expect(signal?.aborted).toBe(true);
    release.resolve(); expect((await pending)[0]?.status).toBe("rejected");
    const reopened = await open(); expect(await reopened.listMedia(CONV)).toEqual([]);
    expect(await bytes.keys(A)).toEqual([]); expect(acks).toEqual([]);
  });

  it.each(["end", "block"] as const)("cancels upload on %s and requires refreshed authority before resume", async (action) => {
    const history = await open(), ports = network(history), entered = deferred(), release = deferred();
    let signal: AbortSignal | undefined;
    ports.request = async (input) => { signal = input.signal; entered.resolve(); await release.promise;
      return new Response(null, { status: 503 }); };
    const client = session(history, ports), fixture = await mediaFixture(id(201), message().id);
    await client.sendMedia(message(), fixture.metadata, fixture.bytes); await client.flush();
    const pending = Promise.allSettled([client.flushMedia()]);
    await entered.promise; await client[action](CONV); expect(signal?.aborted).toBe(true);
    release.resolve(); expect((await pending)[0]?.status).toBe("rejected");
    await expect(client.flushMedia()).rejects.toThrow();
    await client.refreshConversations(); await client.flushMedia();
    expect(uploads).toEqual([]); // the overridden POST never commits, and no retry is eligible
    expect(acks).toEqual([]);
  });
});
