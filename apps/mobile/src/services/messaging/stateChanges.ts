import type { MessagingScope } from "./history";
import { positiveSequence, uuid } from "./validation";

interface StateBase {
  eventId: string;
  /** Independent metadata stream; never compare with a message sequence. */
  sequence: number;
  conversationId: string;
  occurredAt: number;
}
interface MessageIdentity {
  messageId: string;
  authorId: string;
  recipientId: string;
  messageSequence: number;
}
export type MessageStateChange = StateBase & (
  | (MessageIdentity & { kind: "UNSEND" | "DELETE_FOR_ME" })
  | { kind: "CLEAR_FOR_ME"; peerId: string; throughSequence: number }
);
export interface StateChangeEnvelope extends MessagingScope { change: MessageStateChange }
export interface StateCursor { eventId: string; sequence: number }

/** Authorized server metadata, never a push payload. The durable stores repeat
 * this validation before applying a tombstone or issuing a persistence result. */
export function copyStateEnvelope(input: StateChangeEnvelope, scope: MessagingScope): StateChangeEnvelope {
  if (!input || input.accountId !== scope.accountId || input.deviceId !== scope.deviceId || !input.change) {
    throw new Error("Messaging state scope mismatch");
  }
  const source = input.change;
  const common = { eventId: uuid(source.eventId), sequence: positiveSequence(source.sequence),
    conversationId: uuid(source.conversationId), occurredAt: positiveSequence(source.occurredAt) };
  let change: MessageStateChange;
  if (source.kind === "CLEAR_FOR_ME") {
    const peerId = uuid(source.peerId);
    if (peerId === scope.accountId) throw new Error("Messaging state participant mismatch");
    change = { ...common, kind: source.kind, peerId, throughSequence: positiveSequence(source.throughSequence) };
  } else if (source.kind === "UNSEND" || source.kind === "DELETE_FOR_ME") {
    const authorId = uuid(source.authorId), recipientId = uuid(source.recipientId);
    if (authorId === recipientId || (authorId !== scope.accountId && recipientId !== scope.accountId)) {
      throw new Error("Messaging state participant mismatch");
    }
    change = { ...common, kind: source.kind, messageId: uuid(source.messageId), authorId, recipientId,
      messageSequence: positiveSequence(source.messageSequence) };
  } else throw new Error("Invalid messaging state change");
  return { ...scope, change };
}

export function statePeer(scope: MessagingScope, change: MessageStateChange): string {
  return change.kind === "CLEAR_FOR_ME" ? change.peerId
    : change.authorId === scope.accountId ? change.recipientId : change.authorId;
}
