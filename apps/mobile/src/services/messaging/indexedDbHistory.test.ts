// @vitest-environment node
import { IDBFactory, IDBDatabase, IDBObjectStore, IDBTransaction, forceCloseDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adapter from "./indexedDbHistory";
import type { HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope, OutgoingAttempt } from "./history";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const DEVICE = "00000000-0000-4000-8000-000000000003";
const OTHER_DEVICE = "00000000-0000-4000-8000-000000000004";
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); handles.forEach((store) => store.close()); });

describe("durable human messaging history (not AI chat)", () => {
  it("reopens the same immutable outgoing message and queued outbox", async () => {
    const first = await open();
    await first.enqueueOutgoing(text);
    first.close();
    const second = await open();
    expect(await second.getMessage(MESSAGE)).toEqual(text);
    expect(await second.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
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
    expect(await one.listMessages(CONVERSATION)).toEqual([text]);
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
    expect(await one.getMessage(MESSAGE)).toEqual(text);
    const read = (await one.getMessage(MESSAGE))!;
    read.body = "changed read result";
    expect(await one.getMessage(MESSAGE)).toEqual(text);
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
    expect(await reopened.getMessage(MESSAGE)).toEqual(text);
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
