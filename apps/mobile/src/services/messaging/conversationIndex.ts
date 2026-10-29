import type { HumanMessage, MessagingScope, OutboxEntry, StoredHumanMessage } from "./history";
import { uuid } from "./validation";

/** Safe participant projection only. No counterpart decision, presence, shared
 * activity timestamp, message body or receipt preference belongs in this shape. */
export interface ConversationProjection {
  conversationId: string;
  peerId: string;
  mode: "REQUEST" | "CONNECTED";
  request: "INCOMING" | "OUTGOING" | "NONE";
  requestEpoch: string | null;
  /** Opaque relationship boundary this projection was observed at. A send or
   * accept binds to it; the server refuses stale intent. Absent only for
   * projections cached by a build that predates the boundary. */
  epoch?: string;
  ownHidden: boolean;
  ownDeclined: boolean;
  ownBlocked: boolean;
  /** Monotonic revision of this viewer's authorized projection, not pair activity. */
  revision: number;
}

export interface LocalConversationState {
  conversationId: string;
  peerId: string;
  readThrough: number;
  updatedAt: number;
  projection?: ConversationProjection;
  observedAt?: number;
}

export interface ConversationSummary {
  conversationId: string;
  peerId: string;
  lastMessage: StoredHumanMessage | null;
  lastSequence: number;
  unreadCount: number;
  pendingCount: number;
  updatedAt: number;
  /** Persisted projection is cached, never proof of current online permission. */
  cachedProjection: ConversationProjection | null;
  projectionObservedAt: number | null;
}

export function nonnegativeSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid conversation read sequence");
  return value;
}

export function conversationPeer(scope: MessagingScope, message: Pick<HumanMessage, "authorId" | "recipientId">): string {
  if (message.authorId === scope.accountId) return uuid(message.recipientId);
  if (message.recipientId === scope.accountId) return uuid(message.authorId);
  throw new Error("Conversation participant scope mismatch");
}

/** Copy exact allowed keys; callers must obtain the input from authorized RPC,
 * not from a push payload or an arbitrary profile/conversation table row. */
export function copyConversationProjection(input: ConversationProjection): ConversationProjection {
  const conversationId = uuid(input?.conversationId);
  const peerId = uuid(input?.peerId);
  if ((input.mode !== "REQUEST" && input.mode !== "CONNECTED")
    || !["INCOMING", "OUTGOING", "NONE"].includes(input.request)
    || (input.mode === "CONNECTED" && input.request !== "NONE")
    || typeof input.ownHidden !== "boolean" || typeof input.ownDeclined !== "boolean"
    || typeof input.ownBlocked !== "boolean") throw new Error("Invalid conversation projection");
  const revision = nonnegativeSequence(input.revision);
  const requestEpoch = input.requestEpoch === null ? null : uuid(input.requestEpoch);
  // The boundary is 64 lowercase hex. A malformed value is refused rather than
  // dropped: silently discarding it would let a queued send bind to whatever
  // boundary happens to be current later.
  const rawEpoch = (input as { epoch?: unknown }).epoch;
  if (rawEpoch !== undefined && rawEpoch !== null
    && (typeof rawEpoch !== "string" || !/^[0-9a-f]{64}$/.test(rawEpoch))) {
    throw new Error("Invalid conversation projection");
  }
  const epoch = typeof rawEpoch === "string" ? rawEpoch : null;
  return { conversationId, peerId, mode: input.mode, request: input.request, requestEpoch,
    ownHidden: input.ownHidden, ownDeclined: input.ownDeclined, ownBlocked: input.ownBlocked, revision,
    ...(epoch ? { epoch } : {}) };
}

/** Both durable adapters use the same local-only inbox semantics. Pending
 * messages sort after server-ordered messages; IDs break ties without inventing
 * server timestamps. Unread counts actual visible incoming records, not gaps. */
export function summarizeConversations(
  scope: MessagingScope,
  states: LocalConversationState[],
  messages: StoredHumanMessage[],
  outbox: OutboxEntry[],
): ConversationSummary[] {
  const rows = new Map<string, ConversationSummary>();
  const read = new Map<string, number>();
  for (const state of states) {
    if (state.peerId === scope.accountId) throw new Error("Conversation peer scope mismatch");
    if (state.projection && (state.projection.conversationId !== state.conversationId
      || state.projection.peerId !== state.peerId)) throw new Error("Conversation projection scope mismatch");
    rows.set(state.conversationId, {
      conversationId: state.conversationId, peerId: state.peerId, lastMessage: null,
      lastSequence: 0, unreadCount: 0, pendingCount: 0, updatedAt: state.updatedAt,
      cachedProjection: state.projection ? copyConversationProjection(state.projection) : null,
      projectionObservedAt: state.observedAt ?? null,
    });
    read.set(state.conversationId, nonnegativeSequence(state.readThrough));
  }
  const pending = new Set(outbox.map((entry) => entry.messageId));
  const ordered = [...messages].sort((a, b) =>
    (a.server?.sequence ?? Infinity) - (b.server?.sequence ?? Infinity) || a.id.localeCompare(b.id));
  for (const message of ordered) {
    const peerId = conversationPeer(scope, message);
    let row = rows.get(message.conversationId);
    if (!row) {
      row = { conversationId: message.conversationId, peerId, lastMessage: null,
        lastSequence: 0, unreadCount: 0, pendingCount: 0, updatedAt: 0,
        cachedProjection: null, projectionObservedAt: null };
      rows.set(row.conversationId, row);
    }
    if (row.peerId !== peerId) throw new Error("Immutable conversation peer conflict");
    row.lastMessage = structuredClone(message);
    row.lastSequence = Math.max(row.lastSequence, message.server?.sequence ?? 0);
    if (pending.has(message.id)) row.pendingCount++;
    if (message.authorId !== scope.accountId && message.unsentAt === undefined
      && (message.server?.sequence ?? 0) > (read.get(row.conversationId) ?? 0)) row.unreadCount++;
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt
    || b.lastSequence - a.lastSequence || a.conversationId.localeCompare(b.conversationId));
}
