import { isUuid, uuid } from "./validation";

/** Authorized, viewer-scoped progress, NOT the legacy global mailbox sequence.
 * Positions count only events disclosed to this actor. No body/presence fields.
 * A checkpoint has this shape only after its complete prefix is durably applied;
 * observing HEAD or importing a portable backup never establishes a checkpoint. */
export interface ConversationHead {
  accountId: string;
  conversationId: string;
  streamId: string;
  epoch: string;
  revision: number;
  position: number;
  messageHead: number;
  stateHead: number;
  serverTime: number;
}

/** Retry bookkeeping for an exact target, never a ready/authority checkpoint. */
export interface ConversationProgress { target: ConversationHead; through: number }

export function copyConversationProgress(input: ConversationProgress): ConversationProgress {
  const target = copyConversationHead(input?.target), through = counter(input?.through);
  if (through > target.position) throw new Error("Invalid conversation retry progress");
  return { target, through };
}

export type ConversationGate =
  | { mode: "ready"; missing: 0 }
  | { mode: "soft"; missing: number }
  | { mode: "blocking"; missing: number | null; reason: "unknown" | "authority" | "integrity" | "state" | "gap" };

/** A resolved publication whose temporary body is unavailable to this device.
 * This is not a fabricated message, tombstone, or claim of historical recovery. */
export interface ConversationUnavailable {
  accountId: string;
  conversationId: string;
  streamId: string;
  position: number;
  sourceId: string;
  messageId: string;
  publishedAt: number;
}

export function copyConversationUnavailable(input: ConversationUnavailable): ConversationUnavailable {
  if (!input || typeof input !== "object" || typeof input.sourceId !== "string"
    || !/^[A-Za-z0-9_:-]{1,256}$/.test(input.sourceId) || counter(input.position) === 0 || counter(input.publishedAt) === 0) {
    throw new Error("Invalid unavailable conversation event");
  }
  return { accountId: uuid(input.accountId), conversationId: uuid(input.conversationId), streamId: opaque(input.streamId),
    position: input.position, sourceId: input.sourceId, messageId: uuid(input.messageId), publishedAt: input.publishedAt };
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid conversation progress");
  return value;
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid conversation authority");
  return value;
}

/** Narrow transport validator: never retain arbitrary server properties. */
export function copyConversationHead(input: unknown): ConversationHead {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid conversation HEAD");
  const value = input as Record<string, unknown>;
  if (!isUuid(value.accountId) || !isUuid(value.conversationId)) throw new Error("Invalid conversation scope");
  const result = {
    accountId: uuid(value.accountId), conversationId: uuid(value.conversationId),
    streamId: opaque(value.streamId), epoch: opaque(value.epoch), revision: counter(value.revision),
    position: counter(value.position), messageHead: counter(value.messageHead), stateHead: counter(value.stateHead),
    serverTime: counter(value.serverTime),
  };
  if (Math.max(result.messageHead, result.stateHead) !== result.position || result.serverTime === 0
    || (result.position > 0 && result.messageHead === result.stateHead)) throw new Error("Invalid conversation HEAD");
  return result;
}

/** Soft permits cached reading/composition, never dispatch before reconciliation.
 * No failure, malformed response or missing checkpoint can turn into ready. */
export function assessConversationHead(checkpoint: ConversationHead | null, input: ConversationHead): ConversationGate {
  let head: ConversationHead, applied: ConversationHead;
  try {
    head = copyConversationHead(input);
    // This is a replay-work count, NOT a count of recoverable message bodies.
    if (checkpoint === null) return { mode: "blocking", missing: head.position, reason: "unknown" };
    applied = copyConversationHead(checkpoint);
  } catch { return { mode: "blocking", missing: null, reason: "integrity" }; }
  if (head.accountId !== applied.accountId || head.conversationId !== applied.conversationId
    || head.streamId !== applied.streamId || head.epoch !== applied.epoch || head.revision !== applied.revision) {
    return { mode: "blocking", missing: null, reason: "authority" };
  }
  const missing = head.position - applied.position;
  if (missing < 0 || head.messageHead < applied.messageHead || head.stateHead < applied.stateHead
    || head.serverTime < applied.serverTime
    || (missing === 0 && (head.messageHead !== applied.messageHead || head.stateHead !== applied.stateHead))) {
    return { mode: "blocking", missing: null, reason: "integrity" };
  }
  if (head.stateHead > applied.position) return { mode: "blocking", missing, reason: "state" };
  if (missing > 10) return { mode: "blocking", missing, reason: "gap" };
  return missing === 0 ? { mode: "ready", missing: 0 } : { mode: "soft", missing };
}

/** Compare-and-set under the adapter's write transaction. The caller must have
 * applied the full disclosed prefix before committing; the adapter cannot prove
 * network completeness. A racing/older reconciliation may never overwrite it. */
export function validateCheckpointCommit(accountId: string, input: ConversationHead,
  expectedInput: ConversationHead | null, storedInput: ConversationHead | null): ConversationHead {
  const next = copyConversationHead(input);
  const expected = expectedInput === null ? null : copyConversationHead(expectedInput);
  const stored = storedInput === null ? null : copyConversationHead(storedInput);
  if (next.accountId !== accountId || (expected && (expected.accountId !== accountId
    || expected.conversationId !== next.conversationId)) || JSON.stringify(expected) !== JSON.stringify(stored)) {
    throw new Error("Conversation checkpoint changed");
  }
  if (stored && next.streamId === stored.streamId && (next.position < stored.position
    || next.messageHead < stored.messageHead || next.stateHead < stored.stateHead || next.revision < stored.revision
    || next.serverTime < stored.serverTime
    || (next.position === stored.position && (next.messageHead !== stored.messageHead || next.stateHead !== stored.stateHead)))) {
    throw new Error("Conversation checkpoint regressed");
  }
  return next;
}
