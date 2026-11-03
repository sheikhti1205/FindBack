import type { MailboxEnvelope, MessagingHistory, MessagingScope, PersistenceReceipt } from "./history";
import { copyConversationHead, type ConversationHead, type ConversationUnavailable } from "./conversationHead";
import { copyMailboxEnvelope } from "./mailbox";
import { copyStateEnvelope, type StateChangeEnvelope } from "./stateChanges";
import { positiveSequence, uuid } from "./validation";

type Entry = { position: number; sourceId: string; messageId: string | null; publishedAt: number } & (
  | { kind: "STATE"; change: StateChangeEnvelope }
  | { kind: "MESSAGE" | "MEDIA"; envelope: MailboxEnvelope }
  | { kind: "MESSAGE" | "MEDIA"; disposition: "UNAVAILABLE" }
);

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid conversation range");
  return input as Record<string, unknown>;
}

function identity(head: ConversationHead): string {
  return JSON.stringify({ ...head, serverTime: 0 });
}

/** Validate the entire bounded page before applying any message or erasure. */
function page(input: unknown, target: ConversationHead, after: number, scope: MessagingScope) {
  const row = object(input), head = copyConversationHead(row.head);
  const through = Math.min(target.position, after + 100);
  if (identity(head) !== identity(target) || head.serverTime < target.serverTime
    || row.afterPosition !== after || row.throughPosition !== through
    || !Array.isArray(row.entries) || row.entries.length !== through - after) throw new Error("Incomplete conversation range");
  const entries: Entry[] = row.entries.map((input, index) => {
    const value = object(input), position = positiveSequence(value.position), publishedAt = positiveSequence(value.publishedAt);
    if (position !== after + index + 1 || publishedAt > head.serverTime || typeof value.sourceId !== "string"
      || !/^[A-Za-z0-9_:-]{1,256}$/.test(value.sourceId)) throw new Error("Invalid conversation publication");
    const base = { position, sourceId: value.sourceId, messageId: value.messageId === null ? null : uuid(value.messageId as string), publishedAt };
    if ((position === head.stateHead && value.kind !== "STATE")
      || (position === head.messageHead && value.kind === "STATE")
      || position > (value.kind === "STATE" ? head.stateHead : head.messageHead)) throw new Error("Conversation publication kind conflict");
    if (value.kind === "STATE") {
      const change = copyStateEnvelope(value.change as StateChangeEnvelope, scope);
      if (change.change.eventId !== base.sourceId || change.change.conversationId !== target.conversationId
        || (change.change.kind !== "CLEAR_FOR_ME" && change.change.messageId !== base.messageId)) throw new Error("Conversation state conflict");
      return { ...base, kind: "STATE", change };
    }
    if ((value.kind !== "MESSAGE" && value.kind !== "MEDIA") || base.messageId === null
      || (value.kind === "MESSAGE" && base.sourceId !== base.messageId)) throw new Error("Invalid conversation publication");
    if (value.disposition === "UNAVAILABLE" && value.envelope === undefined) return { ...base, kind: value.kind, disposition: "UNAVAILABLE" };
    if (value.disposition !== undefined) throw new Error("Invalid conversation disposition");
    const envelope = copyMailboxEnvelope(value.envelope, scope);
    if (envelope.event.message.id !== base.messageId || envelope.event.message.conversationId !== target.conversationId
      || envelope.event.eventId !== base.messageId) throw new Error("Conversation message conflict");
    return { ...base, kind: value.kind, envelope };
  });
  return { head, through, entries };
}

/** Call only after account-level canonical state replay (including deleted peers).
 * A fixed target closes finitely; missing/expired bodies become durable honest
 * dispositions, NOT fake messages or proof of complete body recovery. */
export async function reconcileConversation(scope: MessagingScope, history: MessagingHistory, input: ConversationHead,
  fetchPage: (head: ConversationHead, after: number) => Promise<unknown>,
  ack: (receipt: PersistenceReceipt) => Promise<void>, live: () => void, onMedia: () => void = () => {}): Promise<ConversationHead> {
  const target = copyConversationHead(input);
  if (target.accountId !== scope.accountId) throw new Error("Conversation account changed");
  live();
  const expected = await history.getConversationCheckpoint(target.conversationId); live();
  if (expected?.streamId === target.streamId && (target.position < expected.position || target.messageHead < expected.messageHead
    || target.stateHead < expected.stateHead || target.serverTime < expected.serverTime || target.revision < expected.revision)) {
    throw new Error("Conversation progress regressed");
  }
  let after = expected?.streamId === target.streamId ? expected.position : 0;
  const progress = await history.getConversationProgress(target.conversationId); live();
  if (progress && identity(progress.target) === identity(target) && progress.target.serverTime <= target.serverTime) {
    after = Math.max(after, progress.through);
  }
  for (let batch = 0; batch < 100; batch++) {
    live();
    const response = await fetchPage(target, after); live();
    const validated = page(response, target, after, scope);
    // Erasure wins even over another entry in this same page. The canonical
    // adapters also enforce existing tombstones/clear cutoffs against replay.
    for (const entry of validated.entries) if (entry.kind === "STATE") {
      live(); await history.applyStateChange(entry.change, "conversation"); live();
    }
    for (const entry of validated.entries) if (entry.kind !== "STATE") {
      live();
      if ("envelope" in entry) {
        await history.persistInboundAndAck(entry.envelope, async receipt => { live(); await ack(receipt); live(); });
      } else {
        const unavailable: ConversationUnavailable = { accountId: target.accountId, conversationId: target.conversationId,
          streamId: target.streamId, position: entry.position, sourceId: entry.sourceId,
          messageId: entry.messageId!, publishedAt: entry.publishedAt };
        await history.recordConversationUnavailable(unavailable);
      }
      live();
      if (entry.kind === "MEDIA" || ("envelope" in entry && entry.envelope.event.message.messageType === "MEDIA")) onMedia();
    }
    after = validated.through;
    if (after === target.position) {
      live(); await history.commitConversationCheckpoint(validated.head, expected); live(); return validated.head;
    }
    // Save only after the full page's durable effects and ACKs. This is an exact
    // target retry token, not a partial HEAD that could unlock stale authority.
    await history.saveConversationProgress({ target: validated.head, through: after }); live();
  }
  throw new Error("Conversation sync is incomplete. Try again.");
}
