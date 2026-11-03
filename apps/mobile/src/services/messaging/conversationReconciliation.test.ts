// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import type { MessagingHistory, MailboxEnvelope } from "./history";
import type { ConversationHead } from "./conversationHead";
import { reconcileConversation } from "./conversationReconciliation";
import { createMessagingSession } from "./session";

const accountId = "00000000-0000-4000-8000-000000000001", deviceId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003", peer = "00000000-0000-4000-8000-000000000004";
const messageId = "00000000-0000-4000-8000-000000000005";
const head: ConversationHead = { accountId, conversationId, epoch: "epoch-a", streamId: "stream-a", revision: 1,
  position: 1, messageHead: 1, stateHead: 0, serverTime: 1_000 };
const envelope: MailboxEnvelope = { accountId, deviceId, mailboxId: "00000000-0000-4000-8000-000000000006", event: {
  kind: "TEXT", eventId: messageId, sequence: 90, message: { id: messageId, conversationId,
    authorId: peer, recipientId: accountId, body: "Real persisted fixture", messageType: "TEXT" } } };
const entry = { position: 1, kind: "MESSAGE", sourceId: messageId, messageId, publishedAt: 900, envelope };
const page = () => ({ head, afterPosition: 0, throughPosition: 1, entries: [entry] });
const handles: MessagingHistory[] = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.close(); });
async function history() { const h = await openWebMessagingHistory({ accountId, deviceId }, { indexedDB: new IDBFactory() }); handles.push(h); return h; }

it("commits a complete prefix only after its canonical message has durably persisted and ACKed", async () => {
  const h = await history(); let acked = false;
  await reconcileConversation({ accountId, deviceId }, h, head, async () => page(), async receipt => {
    expect(receipt.eventId).toBe(messageId);
    expect((await h.getMessage(messageId))?.body).toBe("Real persisted fixture");
    expect(await h.getConversationCheckpoint(conversationId)).toBeNull(); acked = true;
  }, () => {});
  expect(acked).toBe(true); expect(await h.getConversationCheckpoint(conversationId)).toEqual(head);
});
it.each([
  { throughPosition: 0 }, { afterPosition: 1 }, { entries: [] },
  { entries: [{ ...entry, position: 2 }] }, { head: { ...head, epoch: "changed" } },
  { entries: [{ ...entry, envelope: { ...envelope, accountId: peer } }] },
])("rejects an incomplete/mixed-authority page before any write: %j", async change => {
  const h = await history();
  await expect(reconcileConversation({ accountId, deviceId }, h, head, async () => ({ ...page(), ...change }), async () => {}, () => {})).rejects.toThrow();
  expect(await h.getConversationCheckpoint(conversationId)).toBeNull(); expect(await h.getMessage(messageId)).toBeNull();
});
it("leaves the checkpoint unknown after a lost ACK even though the message commit succeeded", async () => {
  const h = await history();
  await expect(reconcileConversation({ accountId, deviceId }, h, head, async () => page(), async () => { throw Error("offline"); }, () => {})).rejects.toThrow("offline");
  expect((await h.getMessage(messageId))?.server?.sequence).toBe(90);
  expect(await h.getConversationCheckpoint(conversationId)).toBeNull();
  await reconcileConversation({ accountId, deviceId }, h, head, async () => page(), async () => {}, () => {});
  expect(await h.getConversationCheckpoint(conversationId)).toEqual(head);
});
it("persists explicit unavailable metadata without inventing a historical message body", async () => {
  const h = await history();
  await reconcileConversation({ accountId, deviceId }, h, head, async () => ({ ...page(), entries: [
    { position: 1, kind: "MESSAGE", sourceId: messageId, messageId, publishedAt: 900, disposition: "UNAVAILABLE" },
  ] }), async () => { throw Error("must not ACK a nonexistent body"); }, () => {});
  expect(await h.getMessage(messageId)).toBeNull();
  expect(await h.listConversationUnavailable(conversationId)).toEqual([
    { accountId, conversationId, streamId: "stream-a", position: 1, sourceId: messageId, messageId, publishedAt: 900 },
  ]);
  expect(await h.getConversationCheckpoint(conversationId)).toEqual(head);
});
it("aborts before cursor certification when account authority changes during a page fetch", async () => {
  const h = await history(); let live = true;
  await expect(reconcileConversation({ accountId, deviceId }, h, head, async () => { live = false; return page(); }, async () => {}, () => {
    if (!live) throw Error("account changed");
  })).rejects.toThrow("account changed");
  expect(await h.getConversationCheckpoint(conversationId)).toBeNull(); expect(await h.getMessage(messageId)).toBeNull();
});

it("uses the actual session's state-first RPC path and skips range replay only for an equal durable prefix", async () => {
  const h = await history(), calls: string[] = [], gates: string[] = [];
  const session = createMessagingSession({ accountId, deviceId }, h, async input => {
    calls.push(input.action);
    if (input.action === "STATE_SYNC") return [];
    if (input.action === "HEAD") return head;
    if (input.action === "CONVERSATION_SYNC") return page();
    if (input.action === "ACK") { expect(await h.getConversationCheckpoint(conversationId)).toBeNull(); return null; }
    throw Error("unexpected action " + input.action);
  });
  await session.reconcileConversation(conversationId, gate => { gates.push(gate.mode); });
  expect(calls).toEqual(["STATE_SYNC", "HEAD", "CONVERSATION_SYNC", "ACK"]);
  expect(gates).toEqual(["blocking", "ready"]);
  calls.length = 0;
  await session.reconcileConversation(conversationId);
  expect(calls).toEqual(["STATE_SYNC", "HEAD"]);
  expect((await h.getMessage(messageId))?.body).toBe("Real persisted fixture");
  await session.close();
});

it("applies page erasures before its older available body and never resurrects it", async () => {
  const h = await history(), stateId = "00000000-0000-4000-8000-000000000007";
  const target = { ...head, position: 2, stateHead: 2 };
  const state = { position: 2, kind: "STATE", sourceId: stateId, messageId, publishedAt: 950,
    change: { accountId, deviceId, change: { kind: "UNSEND", eventId: stateId, sequence: 1,
      conversationId, messageId, authorId: peer, recipientId: accountId, messageSequence: 90, occurredAt: 950 } } };
  await reconcileConversation({ accountId, deviceId }, h, target,
    async () => ({ head: target, afterPosition: 0, throughPosition: 2, entries: [entry, state] }), async () => {
      expect((await h.getMessage(messageId))?.unsentAt).toBe(950);
    }, () => {});
  expect((await h.getMessage(messageId))?.body).toBe("");
  expect(await h.getConversationCheckpoint(conversationId)).toEqual(target);
});
it("never certifies a partial multi-page range, then safely replays durable unavailable records", async () => {
  const h = await history(), target = { ...head, position: 101, messageHead: 101 };
  const fetch = async (_head: ConversationHead, after: number) => {
    const through = Math.min(after + 100, 101);
    return { head: target, afterPosition: after, throughPosition: through, entries: Array.from({ length: through - after }, (_, i) => {
      const position = after + i + 1, id = `00000000-0000-4000-8000-${position.toString(16).padStart(12, "0")}`;
      return { position, kind: "MESSAGE", sourceId: id, messageId: id, publishedAt: 900, disposition: "UNAVAILABLE" };
    }) };
  };
  await expect(reconcileConversation({ accountId, deviceId }, h, target, async (head, after) => {
    if (after === 100) throw Error("offline second page"); return fetch(head, after);
  }, async () => {}, () => {})).rejects.toThrow("offline second page");
  expect(await h.getConversationCheckpoint(conversationId)).toBeNull();
  expect(await h.listConversationUnavailable(conversationId)).toHaveLength(100);
  await reconcileConversation({ accountId, deviceId }, h, target, fetch, async () => {}, () => {});
  expect(await h.listConversationUnavailable(conversationId)).toHaveLength(101);
  expect(await h.getConversationCheckpoint(conversationId)).toEqual(target);
});

it("reconciles and certifies missing canonical history before the actual queued SEND admission", async () => {
  const h = await history(), ownId = "00000000-0000-4000-8000-000000000008";
  const own = { id: ownId, conversationId, authorId: accountId, recipientId: peer, body: "Queued reply", messageType: "TEXT" as const };
  await h.enqueueOutgoing(own, "epoch-a");
  let sent = false, ownAck = false;
  const session = createMessagingSession({ accountId, deviceId }, h, async input => {
    if (input.action === "STATE_SYNC") return [];
    if (input.action === "HEAD") return head;
    if (input.action === "CONVERSATION_SYNC") return page();
    if (input.action === "SEND") {
      expect(await h.getConversationCheckpoint(conversationId)).toEqual(head);
      expect((await h.getMessage(messageId))?.body).toBe("Real persisted fixture");
      expect(input.args.expectedHead).toEqual(head);
      expect(input.args.expectedEpoch).toBe("epoch-a"); sent = true; return ownId;
    }
    if (input.action === "SYNC") return sent && !ownAck ? [{ ...envelope, mailboxId: ownId,
      event: { kind: "TEXT", eventId: ownId, sequence: 91, message: own } }] : [];
    if (input.action === "ACK") { if (input.args.mailboxId === ownId) ownAck = true; return null; }
    throw Error("unexpected " + input.action);
  });
  await session.flush(); expect(sent).toBe(true); expect(await h.listOutbox()).toEqual([]);
  await session.close();
});
it("does not dispatch a queued send when its missing range cannot be closed", async () => {
  const h = await history();
  await h.enqueueOutgoing({ id: "00000000-0000-4000-8000-000000000008", conversationId, authorId: accountId,
    recipientId: peer, body: "Do not dispatch yet", messageType: "TEXT" }, "epoch-a");
  let sent = false;
  const session = createMessagingSession({ accountId, deviceId }, h, async input => {
    if (input.action === "STATE_SYNC" || input.action === "SYNC") return [];
    if (input.action === "HEAD") return head;
    if (input.action === "CONVERSATION_SYNC") return { ...page(), entries: [] };
    if (input.action === "SEND") { sent = true; return input.args.messageId; }
    throw Error("unexpected " + input.action);
  });
  await expect(session.flush()).rejects.toThrow();
  expect(sent).toBe(false); expect(await h.getConversationCheckpoint(conversationId)).toBeNull();
  await session.close();
});

it("keeps queued relationship intent rather than rebinding it to the newly reconciled epoch", async () => {
  const h = await history(), ownId = "00000000-0000-4000-8000-000000000008";
  await h.enqueueOutgoing({ id: ownId, conversationId, authorId: accountId, recipientId: peer,
    body: "Old relationship intent", messageType: "TEXT" }, "epoch-old");
  let attempted = false;
  const session = createMessagingSession({ accountId, deviceId }, h, async input => {
    if (input.action === "STATE_SYNC" || input.action === "SYNC") return [];
    if (input.action === "HEAD") return head;
    if (input.action === "CONVERSATION_SYNC") return page();
    if (input.action === "ACK") return null;
    if (input.action === "SEND") {
      expect(input.args.expectedEpoch).toBe("epoch-old"); expect(input.args.expectedHead).toEqual(head);
      attempted = true; throw Error("Relationship boundary moved");
    }
    throw Error("unexpected " + input.action);
  });
  await expect(session.flush()).rejects.toThrow("Relationship boundary moved");
  expect(attempted).toBe(true); expect((await h.listOutbox())[0]?.status).toBe("FAILED");
  await session.close();
});
it("rechecks local erasure after missing-range reconciliation before sending a claimed row", async () => {
  const h = await history(), ownId = "00000000-0000-4000-8000-000000000008";
  await h.enqueueOutgoing({ id: ownId, conversationId, authorId: accountId, recipientId: peer,
    body: "Removed on another device", messageType: "TEXT" }, "epoch-a");
  const target = { ...head, messageHead: 0, stateHead: 1 };
  let sent = false;
  const session = createMessagingSession({ accountId, deviceId }, h, async input => {
    if (input.action === "STATE_ACK") return null;
    if (input.action === "STATE_SYNC" || input.action === "SYNC") return [];
    if (input.action === "HEAD") return target;
    if (input.action === "CONVERSATION_SYNC") return { head: target, afterPosition: 0, throughPosition: 1, entries: [{
      position: 1, kind: "STATE", sourceId: messageId, messageId: ownId, publishedAt: 900,
      change: { accountId, deviceId, change: { kind: "DELETE_FOR_ME", eventId: messageId, sequence: 1,
        conversationId, messageId: ownId, authorId: accountId, recipientId: peer, messageSequence: 90, occurredAt: 900 } },
    }] };
    if (input.action === "SEND") { sent = true; return ownId; }
    throw Error("unexpected " + input.action);
  });
  await expect(session.flush()).rejects.toThrow("Message is no longer pending");
  expect(sent).toBe(false); expect(await h.getConversationCheckpoint(conversationId)).toEqual(target);
  expect((await h.getMessage(ownId))?.body).not.toBe("Removed on another device");
  await session.close();
});
