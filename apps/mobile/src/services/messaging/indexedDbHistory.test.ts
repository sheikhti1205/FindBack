// @vitest-environment node
import { IDBFactory, IDBDatabase, IDBObjectStore, IDBTransaction, IDBCursor, forceCloseDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adapter from "./indexedDbHistory";
import type { HumanMessage, MailboxEnvelope, MediaBytesPort, MessagingHistory, MessagingScope, OutgoingAttempt, StoredHumanMessage } from "./history";
import { MEDIA_SWEEP_GRACE_MS, type MediaMetadata } from "./media";
import { afterNextHistoryOperation, FakeMediaBytes, mediaBytes, mediaFixture } from "./mediaTestDoubles";
import type { StateChangeEnvelope } from "./stateChanges";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const DEVICE = "00000000-0000-4000-8000-000000000003";
const OTHER_DEVICE = "00000000-0000-4000-8000-000000000004";
const C = "00000000-0000-4000-8000-00000000000f";
const MESSAGE = "00000000-0000-4000-8000-000000000005";
const CONVERSATION = "00000000-0000-4000-8000-000000000006";
const EVENT = "00000000-0000-4000-8000-000000000007";
const MAILBOX = "00000000-0000-4000-8000-000000000008";
const scope = { accountId: A, deviceId: DEVICE };
const text: HumanMessage = { id: MESSAGE, conversationId: CONVERSATION, authorId: A, recipientId: B, body: "Please help me find my bag." };
function envelope(message = { ...text, authorId: B, recipientId: A }): MailboxEnvelope {
  return { ...scope, mailboxId: MAILBOX, event: { kind: "TEXT", eventId: EVENT, sequence: 1, message } };
}

let factory: IDBFactory;
let handles: MessagingHistory[];
async function open(identity: MessagingScope = scope) {
  const store = await adapter.openWebMessagingHistory(identity, { indexedDB: factory });
  handles.push(store);
  return store;
}
beforeEach(() => { factory = new IDBFactory(); handles = []; });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(handles.map((store) => store.close())); });

describe("durable human messaging history (not AI chat)", () => {
  it("reopens the same immutable outgoing message and queued outbox", async () => {
    const first = await open();
    await first.enqueueOutgoing(text);
    first.close();
    const second = await open();
    expect(await second.getMessage(MESSAGE)).toEqual({ ...text, messageType: "TEXT" });
    expect(await second.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
  });

  it("reopens authoritative TEXT and MEDIA classifications", async () => {
    const bytes = new FakeMediaBytes(() => CLOCK);
    const first = await openWithMedia(bytes);
    await first.enqueueOutgoing(text);
    const mediaMessage = { ...text, id: "00000000-0000-4000-8000-000000000009", body: "" };
    const fixture = await mediaFixture("00000000-0000-4000-8000-00000000000a", mediaMessage.id);
    await first.enqueueOutgoingWithMedia(mediaMessage, fixture.metadata, fixture.bytes);
    await first.close();

    const reopened = await openWithMedia(bytes);
    expect(await reopened.getMessage(MESSAGE)).toMatchObject({ messageType: "TEXT" });
    expect(await reopened.getMessage(mediaMessage.id)).toMatchObject({ body: "", messageType: "MEDIA" });
  });

  it("rolls back message and outbox if the transaction aborts after the message write succeeds", async () => {
    const store = await open();
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(store.enqueueOutgoing(text)).rejects.toThrow();
    vi.restoreAllMocks();
    store.close();
    const reopened = await open();
    expect(await reopened.getMessage(MESSAGE)).toBeNull();
    expect(await reopened.listOutbox()).toEqual([]);
  });

  it("deduplicates five retries and concurrent handles without replacing immutable content", async () => {
    const one = await open();
    const two = await open();
    await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? one : two).enqueueOutgoing(text)));
    expect(await one.listMessages(CONVERSATION)).toEqual([{ ...text, messageType: "TEXT" }]);
    expect(await two.listOutbox()).toHaveLength(1);
    await expect(two.enqueueOutgoing({ ...text, body: "different" })).rejects.toThrow(/conflict/i);
    await expect(two.enqueueOutgoing({ ...text, recipientId: DEVICE })).rejects.toThrow(/conflict/i);
    expect((await one.getMessage(MESSAGE))?.body).toBe("Please help me find my bag.");
  });

  it("isolates accounts and installations even with the same message ID", async () => {
    const one = await open();
    const otherAccount = await open({ accountId: B, deviceId: DEVICE });
    const otherDevice = await open({ accountId: A, deviceId: OTHER_DEVICE });
    await one.enqueueOutgoing(text);
    for (const isolated of [otherAccount, otherDevice]) {
      expect(await isolated.getMessage(MESSAGE)).toBeNull();
      expect(await isolated.listMessages(CONVERSATION)).toEqual([]);
      expect(await isolated.listOutbox()).toEqual([]);
    }
    await otherAccount.enqueueOutgoing({ ...text, authorId: B, recipientId: A, body: "other account" });
    expect((await one.getMessage(MESSAGE))?.body).toBe("Please help me find my bag.");
  });

  it("copies caller identity and input rather than allowing mutation to change stored scope/content", async () => {
    const identity = { ...scope };
    const one = await open(identity);
    identity.accountId = B;
    const input = { ...text };
    const saved = one.enqueueOutgoing(input);
    input.body = "changed after call";
    await saved;
    expect(await one.getMessage(MESSAGE)).toEqual({ ...text, messageType: "TEXT" });
    const read = (await one.getMessage(MESSAGE))!;
    read.body = "changed read result";
    expect(await one.getMessage(MESSAGE)).toEqual({ ...text, messageType: "TEXT" });
  });

  it("fails closed when signed out, device identity is missing, or durable storage is unavailable", async () => {
    await expect(open({ accountId: "", deviceId: DEVICE })).rejects.toThrow();
    await expect(open({ accountId: A, deviceId: "hardware-fingerprint" })).rejects.toThrow();
    vi.stubGlobal("indexedDB", undefined);
    await expect(adapter.openWebMessagingHistory(scope)).rejects.toThrow(/storage|IndexedDB/i);
  });

  it("does not claim saved history when IndexedDB opening is denied", async () => {
    vi.spyOn(factory, "open").mockImplementation(() => { throw new DOMException("Storage denied", "SecurityError"); });
    await expect(open()).rejects.toThrow("Storage denied");
  });

  it("rejects writes from another author and malformed/unbounded text", async () => {
    const one = await open();
    for (const message of [{ ...text, authorId: B }, { ...text, body: "" }, { ...text, body: "x".repeat(100_001) }, { ...text, id: "not-a-uuid" }]) {
      await expect(one.enqueueOutgoing(message)).rejects.toThrow();
    }
    expect(await one.listOutbox()).toEqual([]);
  });

  it("invalidates all operations and aborts in-flight writes on close", async () => {
    const one = await open();
    const pending = one.enqueueOutgoing(text);
    one.close();
    await expect(pending).rejects.toThrow();
    await expect(one.getMessage(MESSAGE)).rejects.toThrow(/closed/i);
    await expect(one.enqueueOutgoing(text)).rejects.toThrow(/closed/i);
    expect(await (await open()).getMessage(MESSAGE)).toBeNull();
  });

  it("invalidates a handle when the browser forcibly closes its connection", async () => {
    const one = await open();
    const original = IDBDatabase.prototype.transaction;
    let connection: IDBDatabase | undefined;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options);
      connection = tx.db;
      return tx;
    });
    await one.enqueueOutgoing(text);
    // fake-indexeddb's declaration incorrectly asks for the constructor; runtime needs the instance.
    forceCloseDatabase(connection as unknown as Parameters<typeof forceCloseDatabase>[0]);
    await expect(one.enqueueOutgoing(text)).rejects.toThrow();
    const acked: string[] = [];
    await expect(one.persistInboundAndAck(envelope(), async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow();
    expect(acked).toEqual([]);
  });

  it("leases a send exactly once across handles, recovers interrupted SENDING after expiry, and fences stale failures", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const one = await open();
    const two = await open();
    await one.enqueueOutgoing(text);
    const claims = await Promise.all([one.claimNextOutgoing(), two.claimNextOutgoing()]);
    const active = claims.find((claim) => claim !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(active.message.id).toBe(MESSAGE);
    expect(active.attempt).toBe(1);
    one.close(); two.close();
    const reopened = await open();
    expect(await reopened.claimNextOutgoing()).toBeNull();
    now += 60_001;
    const retry = (await reopened.claimNextOutgoing())!;
    expect(retry.message.id).toBe(MESSAGE);
    expect(retry.attempt).toBe(2);
    expect(retry.token).not.toBe(active.token);
    expect(await reopened.failOutgoing(active)).toBe(false);
    expect(await reopened.failOutgoing(retry)).toBe(true);
    expect(await reopened.listOutbox()).toEqual([{ messageId: MESSAGE, status: "FAILED", attempts: 2 }]);
    expect((await reopened.claimNextOutgoing())?.attempt).toBe(3);
    expect((await reopened.getMessage(MESSAGE))?.server).toBeUndefined();
  });

  it("marks sent only from a matching authoritative echo and never requeues a sent message", async () => {
    const one = await open();
    await one.enqueueOutgoing(text);
    const attempt = (await one.claimNextOutgoing())!;
    await expect(one.persistInbound(envelope({ ...text, body: "conflicting server response" }))).rejects.toThrow(/conflict/i);
    expect(await one.listOutbox()).toHaveLength(1);
    await one.persistInbound(envelope(text));
    expect(await one.listOutbox()).toEqual([]);
    expect((await one.getMessage(MESSAGE))?.server).toEqual({ eventId: EVENT, sequence: 1 });
    expect(await one.failOutgoing(attempt)).toBe(false);
    await one.enqueueOutgoing(text);
    expect(await one.listOutbox()).toEqual([]);
  });

  it("rolls back authoritative sent metadata and outbox removal together on abort", async () => {
    const one = await open();
    await one.enqueueOutgoing(text);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(one.persistInbound(envelope(text))).rejects.toThrow();
    vi.restoreAllMocks();
    one.close();
    const reopened = await open();
    expect(await reopened.getMessage(MESSAGE)).toEqual({ ...text, messageType: "TEXT" });
    expect(await reopened.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    await reopened.persistInbound(envelope(text));
    expect(await reopened.listOutbox()).toEqual([]);
  });

  it("waits for transaction completion before permitting ACK, not merely successful writes", async () => {
    const one = await open();
    let wrote = false;
    let completed = false;
    const acceptedDurability: string[] = [];
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalAdd.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => { wrote = true; });
      return request;
    });
    const originalTx = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = originalTx.call(this, names, mode, options);
      if (mode === "readwrite") {
        acceptedDurability.push(tx.durability);
        tx.addEventListener("complete", () => { completed = true; });
      }
      return tx;
    });
    const acked: string[] = [];
    await one.persistInboundAndAck(envelope(), async (receipt) => {
      expect(wrote).toBe(true);
      expect(completed).toBe(true);
      expect((await (await open()).getMessage(MESSAGE))?.body).toBe(text.body);
      acked.push(receipt.mailboxId);
    });
    expect(acked).toEqual([MAILBOX]);
    expect(acceptedDurability).toEqual(["strict"]);
  });

  it("never ACKs an aborted inbound write, even after request success", async () => {
    const one = await open();
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    const acked: string[] = [];
    await expect(one.persistInboundAndAck(envelope(), async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow();
    expect(acked).toEqual([]);
    vi.restoreAllMocks();
    expect(await one.getMessage(MESSAGE)).toBeNull();
    await one.persistInbound(envelope()); // rollback removed event identity too
  });

  it("never ACKs quota failure and rolls back the earlier event write", async () => {
    const one = await open();
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "messages") throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, value, key);
    });
    const acked: string[] = [];
    await expect(one.persistInboundAndAck(envelope(), async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow("Storage full");
    expect(acked).toEqual([]);
    vi.restoreAllMocks();
    one.close();
    const reopened = await open();
    expect(await reopened.getMessage(MESSAGE)).toBeNull();
    await reopened.persistInbound(envelope());
  });

  it("never ACKs after sign-out closes a transaction with successful message writes", async () => {
    const one = await open();
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => one.close());
      return request;
    });
    const acked: string[] = [];
    await expect(one.persistInboundAndAck(envelope(), async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow();
    expect(acked).toEqual([]);
    vi.restoreAllMocks();
    expect(await (await open()).getMessage(MESSAGE)).toBeNull();
  });

  it("rejects reuse of one mailbox ID for a different event without ACK", async () => {
    const one = await open();
    await one.persistInbound(envelope());
    one.close();
    const reopened = await open();
    const different = envelope({ ...text, id: OTHER_DEVICE, authorId: B, recipientId: A });
    different.event.eventId = B;
    different.event.sequence = 2;
    const acked: string[] = [];
    await expect(reopened.persistInboundAndAck(different, async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow(/conflict/i);
    expect(acked).toEqual([]);
    expect(await reopened.getMessage(OTHER_DEVICE)).toBeNull();
  });

  it("replays safely after ACK failure and reopen without duplicate history", async () => {
    const one = await open();
    await expect(one.persistInboundAndAck(envelope(), async () => { throw new Error("network offline"); })).rejects.toThrow("network offline");
    one.close();
    const reopened = await open();
    const acked: string[] = [];
    await reopened.persistInboundAndAck(envelope(), async (receipt) => { acked.push(receipt.mailboxId); });
    expect(acked).toEqual([MAILBOX]);
    expect(await reopened.listMessages(CONVERSATION)).toHaveLength(1);
  });

  it("rejects envelope scope, participants, event ID/sequence conflicts and unsupported tombstones without ACK", async () => {
    const one = await open();
    const incoming = envelope();
    await one.persistInbound(incoming);
    const bad = [
      { ...incoming, accountId: B }, { ...incoming, deviceId: OTHER_DEVICE },
      { ...incoming, event: { ...incoming.event, message: { ...incoming.event.message, recipientId: DEVICE } } },
      { ...incoming, event: { ...incoming.event, sequence: 2 } },
      { ...incoming, event: { ...incoming.event, message: { ...incoming.event.message, body: "changed" } } },
      { ...incoming, event: { ...incoming.event, eventId: OTHER_DEVICE } },
      { ...incoming, event: { ...incoming.event, sequence: 0 } },
      { ...incoming, event: { ...incoming.event, kind: "UNSEND" } },
    ];
    const acked: string[] = [];
    for (const value of bad) {
      await expect(one.persistInboundAndAck(value as MailboxEnvelope, async (receipt) => { acked.push(receipt.mailboxId); })).rejects.toThrow();
    }
    expect(acked).toEqual([]);
    expect((await one.getMessage(MESSAGE))?.body).toBe(text.body);
  });

  it("accepts out-of-order stable sequences without advancing a synthetic mailbox cursor", async () => {
    const one = await open();
    const second = envelope({ ...text, id: OTHER_DEVICE, authorId: B, recipientId: A, body: "second" });
    second.mailboxId = OTHER_DEVICE;
    second.event.eventId = DEVICE;
    second.event.sequence = 2;
    await one.persistInbound(second);
    await one.persistInbound(envelope());
    expect((await one.listMessages(CONVERSATION)).map((message) => message.body)).toEqual([text.body, "second"]);
    const collision = envelope({ ...text, id: MAILBOX, authorId: B, recipientId: A });
    collision.mailboxId = EVENT;
    collision.event.eventId = B;
    await expect(one.persistInbound(collision)).rejects.toThrow();
    expect(await one.getMessage(MAILBOX)).toBeNull();
  });
});

describe("strict durability capability fails closed before storage actions", () => {
  for (const capability of ["default", "relaxed", "missing", "unknown", "constructor-throw"] as const) {
    for (const operation of ["enqueue", "receipt", "ack", "claim", "fail"] as const) {
      it(`rejects ${operation} when strict capability is ${capability}, with no storage requests and no ACK`, async () => {
        const one = await open();
        let attempt: OutgoingAttempt | undefined;
        if (operation === "claim" || operation === "fail") await one.enqueueOutgoing(text);
        if (operation === "fail") attempt = (await one.claimNextOutgoing())!;
        const beforeMessages = await one.listMessages(CONVERSATION);
        const beforeOutbox = await one.listOutbox();
        const acks: string[] = [];
        const created: IDBTransaction[] = [];
        const aborted: IDBTransaction[] = [];
        const completed: IDBTransaction[] = [];
        const accessedStores: string[] = [];
        const originalStore = IDBTransaction.prototype.objectStore;
        const storeSpy = vi.spyOn(IDBTransaction.prototype, "objectStore").mockImplementation(function (this: IDBTransaction, name) {
          if (this.mode === "readwrite") accessedStores.push(name);
          return originalStore.call(this, name);
        });
        const originalTx = IDBDatabase.prototype.transaction;
        const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
          if (mode !== "readwrite") return originalTx.call(this, names, mode, options);
          expect(options?.durability).toBe("strict");
          if (capability === "constructor-throw") throw new DOMException("Strict durability unsupported", "NotSupportedError");
          const tx = originalTx.call(this, names, mode, capability === "relaxed" ? { durability: "relaxed" } : undefined);
          if (capability === "missing") Reflect.deleteProperty(tx, "durability");
          if (capability === "unknown") Object.defineProperty(tx, "durability", { value: "unknown-runtime-mode" });
          created.push(tx);
          tx.addEventListener("abort", () => { aborted.push(tx); });
          tx.addEventListener("complete", () => { completed.push(tx); });
          return tx;
        });
        const pending = operation === "enqueue" ? one.enqueueOutgoing(text)
          : operation === "receipt" ? one.persistInbound(envelope())
          : operation === "ack" ? one.persistInboundAndAck(envelope(), async (receipt) => { acks.push(receipt.mailboxId); })
          : operation === "claim" ? one.claimNextOutgoing() : one.failOutgoing(attempt!);
        await expect(pending).rejects.toThrow(/strict.*durability|durability.*strict/i);
        expect(accessedStores).toEqual([]); // No object store was opened, so no request/write was issued.
        expect(acks).toEqual([]);
        expect(created).toHaveLength(capability === "constructor-throw" ? 0 : 1);
        expect(aborted).toEqual(created); // Rejection settles after abort, not before cleanup.
        expect(completed).toEqual([]);

        // Readonly remains usable with the non-strict runtime still installed.
        expect(await one.listMessages(CONVERSATION)).toEqual(beforeMessages);
        expect(await one.listOutbox()).toEqual(beforeOutbox);
        txSpy.mockRestore(); storeSpy.mockRestore();
        one.close();
        const reopened = await open();
        expect(await reopened.listMessages(CONVERSATION)).toEqual(beforeMessages);
        expect(await reopened.listOutbox()).toEqual(beforeOutbox);
        // The capability failure neither poisons this scope nor consumes IDs/lease transitions.
        if (operation === "enqueue") {
          await reopened.enqueueOutgoing(text);
          expect(await reopened.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
        } else if (operation === "receipt" || operation === "ack") {
          await reopened.persistInboundAndAck(envelope(), async (receipt) => { acks.push(receipt.mailboxId); });
          expect(acks).toEqual([MAILBOX]);
        } else if (operation === "claim") {
          expect((await reopened.claimNextOutgoing())?.attempt).toBe(1);
        } else {
          expect(await reopened.failOutgoing(attempt!)).toBe(true);
          expect(await reopened.listOutbox()).toEqual([{ messageId: MESSAGE, status: "FAILED", attempts: 1 }]);
        }
      });
    }
  }
});

const MESSAGE_2 = "00000000-0000-4000-8000-00000000000a";
const EVENT_2 = "00000000-0000-4000-8000-00000000000b";
const MAILBOX_2 = "00000000-0000-4000-8000-00000000000c";
const STATE = "00000000-0000-4000-8000-00000000000d";
const STATE_2 = "00000000-0000-4000-8000-00000000000e";

const DB_NAME = `findback-human-history-v1:${A}:${DEVICE}`;

async function rawDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME); // Inspection, not a downgrade request.
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawMessage(id = MESSAGE): Promise<StoredHumanMessage | undefined> {
  const db = await rawDatabase();
  const request = db.transaction("messages", "readonly").objectStore("messages").get(id);
  const value = await new Promise<StoredHumanMessage | undefined>((resolve) => {
    request.onsuccess = () => resolve(request.result as StoredHumanMessage | undefined);
  });
  db.close();
  return value;
}

async function rawDeleteMessage(id = MESSAGE): Promise<void> {
  const db = await rawDatabase();
  const tx = db.transaction("messages", "readwrite");
  tx.objectStore("messages").delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

function state(change: StateChangeEnvelope["change"]): StateChangeEnvelope {
  return { ...scope, change };
}

describe("server-authoritative erasure state (web parity with SQLite)", () => {
  it("applies an author unsend as a body-less tombstone and rejects a wrong recipient", async () => {
    const one = await open();
    await one.persistInbound(envelope());

    await expect(one.applyStateChange(state({
      kind: "UNSEND", eventId: STATE, sequence: 1, conversationId: CONVERSATION, occurredAt: 10,
      messageId: MESSAGE, authorId: B, recipientId: C, messageSequence: 1,
    }))).rejects.toThrow(/participant mismatch|identity conflict/);
    expect((await one.getMessage(MESSAGE))?.body).toBe("Please help me find my bag.");

    await one.applyStateChange(state({
      kind: "UNSEND", eventId: STATE_2, sequence: 2, conversationId: CONVERSATION, occurredAt: 11,
      messageId: MESSAGE, authorId: B, recipientId: A, messageSequence: 1,
    }));
    expect(await one.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: 11 });
  });

  it("applies delete-for-me as local erasure of the stored body", async () => {
    const one = await open();
    await one.persistInbound(envelope());
    await one.applyStateChange(state({
      kind: "DELETE_FOR_ME", eventId: STATE, sequence: 1, conversationId: CONVERSATION, occurredAt: 10,
      messageId: MESSAGE, authorId: B, recipientId: A, messageSequence: 1,
    }));
    expect(await one.getMessage(MESSAGE)).toBeNull();
    expect(await one.listMessages(CONVERSATION)).toEqual([]);
    expect((await rawMessage())?.body).toBe("");
  });

  it("applies clear-for-me through a sequence and erases only the covered bodies", async () => {
    const one = await open();
    await one.persistInbound(envelope());
    const second: HumanMessage = { ...text, id: MESSAGE_2, authorId: B, recipientId: A, body: "second" };
    await one.persistInbound({ ...scope, mailboxId: MAILBOX_2,
      event: { kind: "TEXT", eventId: EVENT_2, sequence: 2, message: second } });

    await one.applyStateChange(state({
      kind: "CLEAR_FOR_ME", eventId: STATE, sequence: 1, conversationId: CONVERSATION,
      occurredAt: 10, peerId: B, throughSequence: 1,
    }));
    expect(await one.getMessage(MESSAGE)).toBeNull();
    expect((await one.listMessages(CONVERSATION)).map((message) => message.body)).toEqual(["second"]);
    expect((await rawMessage())?.body).toBe("");
  });

  it("does not resurrect a message when a recorded envelope is replayed after local deletion", async () => {
    const one = await open();
    await one.persistInbound(envelope());
    await rawDeleteMessage();
    expect(await one.getMessage(MESSAGE)).toBeNull();

    await one.persistInbound(envelope());
    expect(await one.getMessage(MESSAGE)).toBeNull();
    expect(await rawMessage()).toBeUndefined();
  });
});

const ATTACHMENT = "00000000-0000-4000-8000-000000000020";
const ATTACHMENT_2 = "00000000-0000-4000-8000-000000000021";
const ORPHAN_ATTACHMENT = "00000000-0000-4000-8000-000000000024";
const MESSAGE_3 = "00000000-0000-4000-8000-000000000025";
const EVENT_3 = "00000000-0000-4000-8000-000000000027";
const MAILBOX_3 = "00000000-0000-4000-8000-000000000028";
const CLOCK = 1_700_000_000_000;

async function openWithMedia(port: MediaBytesPort, identity: MessagingScope = scope) {
  const store = await adapter.openWebMessagingHistory(identity, {
    indexedDB: factory, mediaBytes: port, decodeMedia: async () => undefined,
  });
  handles.push(store);
  await store.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "CONNECTED", request: "NONE",
    requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 });
  return store;
}

function rawMediaDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, adapter.MESSAGING_IDB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawMediaRows(): Promise<Array<Record<string, unknown>>> {
  const db = await rawMediaDatabase();
  const request = db.transaction("mediaAttachments", "readonly").objectStore("mediaAttachments").getAll();
  const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

/** Write a v3 database by hand: the shape the previous build left on disk. */
function seedV3(version = 3, attachment?: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("conversation", "conversationId");
      db.createObjectStore("outbox", { keyPath: "messageId" });
      db.createObjectStore("mailbox", { keyPath: "mailboxId" });
      const events = db.createObjectStore("events", { keyPath: "eventId" });
      events.createIndex("sequence", ["conversationId", "sequence"], { unique: true });
      db.createObjectStore("conversations", { keyPath: "conversationId" });
      const stateEvents = db.createObjectStore("stateEvents", { keyPath: "eventId" });
      stateEvents.createIndex("sequence", "sequence", { unique: true });
      db.createObjectStore("deletions", { keyPath: "messageId" });
      db.createObjectStore("unsends", { keyPath: "messageId" });
      db.createObjectStore("clears", { keyPath: "conversationId" });
      if (version === 4) {
        db.createObjectStore("mediaAttachments", { keyPath: "id" })
          .createIndex("messageId", "messageId", { unique: true });
        db.createObjectStore("mediaLifecycle");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(version === 4 ? ["messages", "outbox", "mediaAttachments"] : ["messages", "outbox"], "readwrite");
      tx.objectStore("messages").put({ ...text, server: { eventId: EVENT, sequence: 1 } });
      tx.objectStore("outbox").put({ messageId: MESSAGE, status: "QUEUED", attempts: 0 });
      if (attachment) {
        tx.objectStore("messages").put({ ...text, id: MESSAGE_2, body: "", unsentAt: CLOCK });
        tx.objectStore("mediaAttachments").put(attachment);
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  });
}

describe("chat media records (web parity with SQLite)", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(CLOCK); });

  it("upgrades real v4 classification, preserving legacy unknowns, suppression and the queued outbox", async () => {
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE_2);
    const attachment = { ...fixture.metadata, state: "EVICTED", attempts: 0, lastAccessAt: CLOCK };
    await seedV3(4, attachment);
    const store = await open();
    expect((await store.getMessage(MESSAGE))?.messageType).toBeUndefined();
    expect(await store.getMessage(MESSAGE_2)).toEqual({ ...text, id: MESSAGE_2, body: "", unsentAt: CLOCK, messageType: "MEDIA" });
    expect(await store.listOutbox()).toEqual([{ messageId: MESSAGE, status: "NEEDS_REVIEW", attempts: 0 }]);
    expect(await rawMediaRows()).toEqual([attachment]);
    store.close();
    const reopened = await open();
    expect((await reopened.getMessage(MESSAGE_2))?.messageType).toBe("MEDIA");
  });

  it("aborts the v4 version change and backfill together and permits a clean retry", async () => {
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE_2);
    const attachment = { ...fixture.metadata, state: "EVICTED", attempts: 0, lastAccessAt: CLOCK };
    await seedV3(4, attachment);
    const cursorPrototype = IDBCursor.prototype;
    const originalUpdate = cursorPrototype.update;
    const fault = vi.spyOn(cursorPrototype, "update").mockImplementation(function (this: IDBCursor, value: unknown) {
      const request = originalUpdate.call(this, value);
      const source = this.source as IDBObjectStore;
      if (source.name === "messages") source.transaction.abort();
      return request;
    });
    await expect(open()).rejects.toThrow();
    fault.mockRestore();
    const request = factory.open(DB_NAME, 4);
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    expect(old.version).toBe(4);
    const read = old.transaction("messages").objectStore("messages").get(MESSAGE_2);
    expect(await new Promise((resolve) => { read.onsuccess = () => resolve(read.result); }))
      .toEqual({ ...text, id: MESSAGE_2, body: "", unsentAt: CLOCK });
    old.close();
    const retry = await open();
    expect((await retry.getMessage(MESSAGE_2))?.messageType).toBe("MEDIA");
  });

  it.each(["purge", "delete"])("does not dispatch ACK when %s wins after commit but before ACK admission", async (action) => {
    const port = new FakeMediaBytes(() => CLOCK);
    const one = await openWithMedia(port), two = await openWithMedia(port);
    await one.persistInbound(envelope());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1000 });
    afterNextHistoryOperation(() => action === "purge" ? two.clearMedia() : two.removeMediaForMessage(MESSAGE));
    const ack = vi.fn(async () => undefined);
    await expect(one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack))
      .rejects.toThrow(/purged|not available|unavailable/i);
    expect(ack).not.toHaveBeenCalled();
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
  });

  it("close drains an admitted byte write and its compensation before the owner can close the port", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    let signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const put = port.put.bind(port);
    vi.spyOn(port, "put").mockImplementation(async (...args) => {
      await put(...args); signalStarted(); await released;
    });
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
    const rejected = expect(store.enqueueOutgoingWithMedia(text, fixture.metadata, fixture.bytes)).rejects.toThrow(/closed/);
    await started;
    let drained = false;
    const closing = Promise.resolve(store.close()).then(() => { drained = true; });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
    } finally {
      release();
      await rejected; await closing;
    }
    expect(await port.keys(A)).toEqual([]);
    expect(await rawMediaRows()).toEqual([]);
  });

  it("refuses media open when origin-wide locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const port = new FakeMediaBytes(() => CLOCK);
    await expect(openWithMedia(port)).rejects.toThrow(/requires Web Locks/);
    expect(await port.keys(A)).toEqual([]);
  });

  it("refuses REQUEST media admission and stops new claims after End", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
    await store.enqueueOutgoingWithMedia(text, fixture.metadata, fixture.bytes);
    await store.persistInbound({ ...envelope(), event: { ...envelope().event, message: text } });
    await store.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "REQUEST", request: "NONE",
      requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 2 });
    expect(await store.claimNextMediaUpload()).toBeNull();
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_3);
    await expect(store.enqueueOutgoingWithMedia({ ...text, id: MESSAGE_3 }, second.metadata, second.bytes))
      .rejects.toThrow(/media unavailable/i);
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
    expect(await store.getMessage(MESSAGE_3)).toBeNull();
  });

  it("sweeps aged orphan bytes on open but preserves the crash grace window", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    port.plant(A, ORPHAN_ATTACHMENT, mediaBytes(), CLOCK - MEDIA_SWEEP_GRACE_MS - 1);
    port.plant(A, ATTACHMENT, mediaBytes(), CLOCK);
    await openWithMedia(port);
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
  });

  it("durably fences other handles and reopen after account media purge", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const one = await openWithMedia(port), two = await openWithMedia(port);
    await one.persistInbound(envelope());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1000 });
    await one.clearMedia();
    const ack = vi.fn(async () => undefined);
    await expect(two.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)).rejects.toThrow(/purged/);
    await one.close(); await two.close();
    const reopened = await openWithMedia(port);
    await expect(reopened.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)).rejects.toThrow(/purged/);
    expect(ack).not.toHaveBeenCalled();
    expect(await port.keys(A)).toEqual([]);
    expect(await rawMediaRows()).toEqual([]);
    await reopened.clearMedia(); // retryable and idempotent cleanup
  });

  it("keeps async ACK completion outside the account lock so callbacks can read committed history", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const one = await openWithMedia(port), two = await openWithMedia(port);
    await one.persistInbound(envelope());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1000 });
    await one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => {
      expect(await two.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
      await two.removeMediaForMessage(MESSAGE);
    });
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
  });

  it("preserves the winner's bytes when a concurrent handle aborts admission", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const one = await openWithMedia(port), two = await openWithMedia(port);
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
    const original = IDBObjectStore.prototype.put;
    let failOnce = true;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "mediaAttachments" && failOnce) {
        failOnce = false;
        request.addEventListener("success", () => this.transaction.abort());
      }
      return request;
    });
    const result = await Promise.allSettled([
      one.enqueueOutgoingWithMedia(text, fixture.metadata, fixture.bytes),
      two.enqueueOutgoingWithMedia(text, fixture.metadata, fixture.bytes),
    ]);
    expect(result.map((entry) => entry.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await rawMediaRows()).toHaveLength(1);
    expect(await port.get(A, ATTACHMENT)).toEqual(fixture.bytes);
    expect(await one.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
  });

  it("never ACKs or creates metadata on byte-store failure", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    await store.persistInbound(envelope());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1000 });
    port.failPut = new Error("quota full");
    let acks = 0;
    await expect(store.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => { acks++; }))
      .rejects.toThrow(/quota full/);
    expect(acks).toBe(0);
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
  });

  it("refuses future databases without changing their version or stores", async () => {
    const request = factory.open(DB_NAME, adapter.MESSAGING_IDB_VERSION + 1);
    request.onupgradeneeded = () => request.result.createObjectStore("future");
    const future = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    future.close();
    await expect(openWithMedia(new FakeMediaBytes(() => CLOCK))).rejects.toThrow();
    const check = factory.open(DB_NAME);
    const db = await new Promise<IDBDatabase>((resolve) => { check.onsuccess = () => resolve(check.result); });
    expect(db.version).toBe(adapter.MESSAGING_IDB_VERSION + 1);
    expect([...db.objectStoreNames]).toEqual(["future"]);
    db.close();
  });

  it("upgrades a v3 database with media stores while quarantining unknown classification", async () => {
    await seedV3();
    const store = await open();
    // Existing records survive the upgrade untouched.
    expect(await store.getMessage(MESSAGE)).toMatchObject({ body: text.body, server: { sequence: 1 } });
    expect(await store.listOutbox()).toEqual([{ messageId: MESSAGE, status: "NEEDS_REVIEW", attempts: 0 }]);

    const db = await rawMediaDatabase();
    expect(Array.from(db.objectStoreNames)).toEqual(expect.arrayContaining([
      "messages", "outbox", "conversations", "stateEvents", "mediaAttachments", "mediaLifecycle",
    ]));
    const index = db.transaction("mediaAttachments", "readonly").objectStore("mediaAttachments")
      .index("messageId");
    expect(index.unique).toBe(true);
    db.close();

    // A second open is idempotent: the store and its index are not recreated.
    store.close();
    const reopened = await open();
    expect(await reopened.getMessage(MESSAGE)).toMatchObject({ body: text.body });
    const again = await rawMediaDatabase();
    expect(again.objectStoreNames.contains("mediaAttachments")).toBe(true);
    again.close();
  });

  it("rejects a record the SQLite CHECKs would refuse, before any write", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    const invalid: Array<[string, MediaMetadata]> = [
      ["uppercase digest", { ...metadata, sha256: "A".repeat(64) }],
      ["unsupported mime", { ...metadata, mime: "image/gif" as never }],
      ["zero size", { ...metadata, byteSize: 0 }],
      ["oversized size", { ...metadata, byteSize: 20 * 1024 * 1024 + 1 }],
      ["zero width", { ...metadata, width: 0 }],
      ["oversized height", { ...metadata, height: 8193 }],
      ["inbound without expiry", { ...metadata, direction: "IN" }],
    ];
    for (const [label, value] of invalid) {
      await expect(store.enqueueOutgoingWithMedia({ ...text, body: "" }, value, bytes), label)
        .rejects.toThrow();
    }
    // A non-uploading record cannot carry a lease.
    await expect(store.enqueueOutgoingWithMedia({ ...text, body: "" }, metadata, bytes)).resolves.toBeUndefined();
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
    const rows = await rawMediaRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "QUEUED", attempts: 0 });
    expect(rows[0]).not.toHaveProperty("token");
    store.close();
  });

  it("keeps one attachment per message and rolls back the second byte write", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const first = await mediaFixture(ATTACHMENT, MESSAGE);
    await store.enqueueOutgoingWithMedia({ ...text, body: "" }, first.metadata, first.bytes);
    await store.persistInbound(envelope({ ...text, body: "" }));

    const second = await mediaFixture(ATTACHMENT_2, MESSAGE);
    await expect(store.enqueueOutgoingWithMedia({ ...text, body: "" }, second.metadata, second.bytes))
      .rejects.toThrow(/identity conflict/i);
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
    expect(await rawMediaRows()).toHaveLength(1);
    store.close();
  });

  it("commits the row before ACK and keeps bytes when ACK fails", async () => {
    const trace: string[] = [];
    const port = new FakeMediaBytes(() => CLOCK, trace);
    const store = await openWithMedia(port);
    await store.persistInbound(envelope());
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: CLOCK + 1_000_000,
    });

    const acked: string[] = [];
    await store.persistVerifiedMediaAndAck(metadata, bytes, async (record) => {
      acked.push(record.id);
      // Visible through a second handle only after the transaction completed.
      const rows = await rawMediaRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: ATTACHMENT, state: "AWAITING_ACK" });
    });
    expect(acked).toEqual([ATTACHMENT]);
    expect((await rawMediaRows())[0]).toMatchObject({ state: "READY" });
    expect(await store.readMedia(ATTACHMENT)).not.toBeNull();

    await store.persistInbound({ ...envelope(), mailboxId: MAILBOX_3,
      event: { kind: "TEXT", eventId: EVENT_3, sequence: 2, message: { ...text, id: MESSAGE_3, authorId: B, recipientId: A, body: "second" } } });
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_3, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await expect(store.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => {
      throw new Error("ack unavailable");
    })).rejects.toThrow(/ack unavailable/);
    expect((await rawMediaRows()).find((row) => row.id === ATTACHMENT_2)).toMatchObject({ state: "AWAITING_ACK" });
    expect(await port.has(A, ATTACHMENT_2)).toBe(true);
    await store.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => undefined);
    expect((await rawMediaRows()).find((row) => row.id === ATTACHMENT_2)).toMatchObject({ state: "READY" });
    store.close();
  });

  it("rejects a digest or MIME mismatch with no row, no ACK and no bytes", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    await store.persistInbound(envelope());
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: CLOCK + 1_000_000,
    });
    const acked: string[] = [];
    const ack = async (record: { id: string }) => { acked.push(record.id); };
    await expect(store.persistVerifiedMediaAndAck({ ...metadata, sha256: "b".repeat(64) }, bytes, ack))
      .rejects.toThrow(/digest mismatch/i);
    await expect(store.persistVerifiedMediaAndAck({ ...metadata, mime: "image/jpeg" }, bytes, ack))
      .rejects.toThrow(/media type mismatch/i);
    expect(acked).toEqual([]);
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
    expect(await store.readMedia(ATTACHMENT)).toBeNull();
    store.close();
  });

  it("defers an inbound attachment whose parent is missing", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: CLOCK + 1_000_000,
    });
    const acked: string[] = [];
    await expect(store.persistVerifiedMediaAndAck(metadata, bytes, async (record) => { acked.push(record.id); }))
      .rejects.toThrow(/parent is not available/);
    expect(acked).toEqual([]);
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
    store.close();
  });

  it("claims once, fences stale attempts and recovers an expired lease", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await store.enqueueOutgoingWithMedia({ ...text, body: "" }, metadata, bytes);
    expect(await store.claimNextMediaUpload()).toBeNull(); // no text echo yet
    await store.persistInbound(envelope({ ...text, body: "" }));

    const claimed = await Promise.all([store.claimNextMediaUpload(), store.claimNextMediaUpload()]);
    const attempts = claimed.filter((attempt) => attempt !== null);
    expect(attempts).toHaveLength(1);
    const first = attempts[0]!;

    vi.spyOn(Date, "now").mockReturnValue(CLOCK + 60_000);
    const second = await store.claimNextMediaUpload();
    expect(second).toMatchObject({ attachmentId: ATTACHMENT, attempt: 2 });
    expect(await store.failMediaUpload(first)).toBe(false);
    expect(await store.completeMediaUpload(first)).toBe(false);
    expect(await store.completeMediaUpload(second!)).toBe(true);
    expect(await store.markMediaReady(ATTACHMENT)).toBe(true);
    expect((await rawMediaRows())[0]).toMatchObject({ state: "READY" });
    store.close();
  });

  it("refuses to claim an attachment whose bytes have gone", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await store.enqueueOutgoingWithMedia({ ...text, body: "" }, metadata, bytes);
    await store.persistInbound(envelope({ ...text, body: "" }));
    await port.delete(A, [ATTACHMENT]);
    await expect(store.claimNextMediaUpload()).rejects.toThrow(/bytes missing/);
    expect((await rawMediaRows())[0]).toMatchObject({ state: "QUEUED", attempts: 0 });
    store.close();
  });

  it("evicts only READY, sweeps orphans and clears the account", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    await store.persistInbound(envelope());
    const ready = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await store.persistVerifiedMediaAndAck(ready.metadata, ready.bytes, async () => undefined);
    await store.persistInbound({ ...envelope(), mailboxId: MAILBOX_3,
      event: { kind: "TEXT", eventId: EVENT_3, sequence: 2,
        message: { ...text, id: MESSAGE_3, authorId: B, recipientId: A } } });
    const pending = await mediaFixture(ATTACHMENT_2, MESSAGE_3, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await expect(store.persistVerifiedMediaAndAck(pending.metadata, pending.bytes, async () => {
      throw new Error("ack unavailable");
    })).rejects.toThrow(/ack unavailable/);

    expect(await store.evictMedia(10)).toBe(1);
    const rows = await rawMediaRows();
    expect(rows.find((row) => row.id === ATTACHMENT)).toMatchObject({
      state: "EVICTED", sha256: ready.metadata.sha256, byteSize: ready.metadata.byteSize,
    });
    expect(rows.find((row) => row.id === ATTACHMENT_2)).toMatchObject({ state: "AWAITING_ACK" });
    expect(await port.has(A, ATTACHMENT)).toBe(false);
    expect(await port.has(A, ATTACHMENT_2)).toBe(true);
    expect(await store.readMedia(ATTACHMENT)).toBeNull();

    port.plant(A, ATTACHMENT, mediaBytes(), CLOCK - MEDIA_SWEEP_GRACE_MS - 1);
    port.plant(A, ORPHAN_ATTACHMENT, mediaBytes(), CLOCK - MEDIA_SWEEP_GRACE_MS - 1);
    expect(await store.sweepOrphanMedia(10)).toBe(2);
    expect(await port.keys(A)).toEqual([ATTACHMENT_2]);

    await store.clearMedia();
    expect(await rawMediaRows()).toEqual([]);
    expect(await port.keys(A)).toEqual([]);
    store.close();
  });

  it("removes one message's attachment and bytes without touching another", async () => {
    const port = new FakeMediaBytes(() => CLOCK);
    const store = await openWithMedia(port);
    await store.persistInbound(envelope());
    const first = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await store.persistInbound({ ...envelope(), mailboxId: MAILBOX_3,
      event: { kind: "TEXT", eventId: EVENT_3, sequence: 2,
        message: { ...text, id: MESSAGE_3, authorId: B, recipientId: A } } });
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_3, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await store.persistVerifiedMediaAndAck(first.metadata, first.bytes, async () => undefined);
    await store.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => undefined);
    await store.removeMediaForMessage(MESSAGE);
    expect((await rawMediaRows()).map((row) => row.id)).toEqual([ATTACHMENT_2]);
    expect(await port.keys(A)).toEqual([ATTACHMENT_2]);
    store.close();
  });

  it("lists visible attachments for a conversation in message order", async () => {
    const store = await openWithMedia(new FakeMediaBytes(() => CLOCK));
    await store.persistInbound({ ...scope, mailboxId: MAILBOX_3,
      event: { kind: "TEXT", eventId: EVENT_3, sequence: 2,
        message: { ...text, id: MESSAGE_3, authorId: B, recipientId: A, body: "second" } } });
    await store.persistInbound(envelope());
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_3, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    const first = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: CLOCK + 1_000_000 });
    await store.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => undefined);
    await store.persistVerifiedMediaAndAck(first.metadata, first.bytes, async () => undefined);
    expect((await store.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([ATTACHMENT, ATTACHMENT_2]);
    store.close();
  });
});
