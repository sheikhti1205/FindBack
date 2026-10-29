/** Portable metadata lives in the existing IDB records, never in delivery/cursor stores. */
import { BackupError } from "./backup";
import { conversationPeer, type LocalConversationState } from "./conversationIndex";
import type { HistorySnapshot, MessagingScope, SnapshotConversation, StoredHumanMessage } from "./history";
import { compatibleMessageType } from "./validation";

export interface PortableMessage extends StoredHumanMessage {
  snapshotCreatedAt?: number;
  /** Distinct from an empty MEDIA caption. Permanent even after mailbox replay. */
  snapshotSuppressed?: true;
}
export interface PortableConversation extends Omit<LocalConversationState, "peerId"> {
  peerId?: string;
  snapshot?: SnapshotConversation;
}
export interface PortableErasure {
  kind: "UNSEND" | "DELETE_FOR_ME";
  messageId: string;
  conversationId: string | null;
  authorId?: string;
  recipientId?: string | null;
  messageSequence?: number;
  occurredAt: number;
  local?: true;
}
export interface PortableClear { conversationId: string; throughSequence: number; occurredAt: number }
export interface PortableView {
  messages: PortableMessage[];
  conversations: PortableConversation[];
  unsends: PortableErasure[];
  deletions: PortableErasure[];
  clears: PortableClear[];
}
function conflict(): never { throw new BackupError("backup: identity conflict"); }

/** Unknown legacy fields may bind to matching authority; known fields never change. */
export function erasureMatches(state: PortableErasure, message: Pick<StoredHumanMessage,
  "id" | "conversationId" | "authorId" | "recipientId">, sequence?: number): boolean {
  return state.messageId === message.id
    && (state.conversationId === null || state.conversationId === message.conversationId)
    && (state.authorId === undefined || state.authorId === message.authorId)
    && (state.recipientId == null || state.recipientId === message.recipientId)
    && (state.messageSequence === undefined || sequence === undefined || state.messageSequence === sequence);
}

export function exportPortable(view: PortableView): HistorySnapshot {
  const conversations = new Map(view.conversations.map((state) => [state.conversationId, {
    id: state.conversationId, lastSequence: state.snapshot?.lastSequence ?? 0,
    createdAt: state.snapshot?.createdAt ?? 0, updatedAt: Math.max(state.updatedAt, state.snapshot?.updatedAt ?? 0),
  }]));
  const deleted = new Set(view.deletions.map((row) => row.messageId));
  const clears = new Map(view.clears.map((row) => [row.conversationId, row.throughSequence]));
  const unsends = new Map(view.unsends.map((row) => [row.messageId, row]));
  const messages = view.messages.filter((row) => row.server).map((row) => {
    const server = row.server!;
    const prior = conversations.get(row.conversationId) ?? { id: row.conversationId, lastSequence: 0, createdAt: 0, updatedAt: 0 };
    prior.lastSequence = Math.max(prior.lastSequence, server.sequence);
    conversations.set(row.conversationId, prior);
    const unsentAt = row.unsentAt ?? unsends.get(row.id)?.occurredAt ?? null;
    return { id: row.id, conversationId: row.conversationId, authorId: row.authorId, recipientId: row.recipientId,
      body: row.snapshotSuppressed || unsentAt !== null || deleted.has(row.id)
        || server.sequence <= (clears.get(row.conversationId) ?? 0) ? null : row.body,
      messageType: row.messageType ?? null, serverEventId: server.eventId, serverSequence: server.sequence,
      unsentAt, createdAt: row.snapshotCreatedAt ?? 0 };
  }).sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.serverSequence - b.serverSequence || a.id.localeCompare(b.id));
  return {
    conversations: [...conversations.values()].sort((a, b) => a.id.localeCompare(b.id)), messages,
    tombstones: view.unsends.map((row) => ({ messageId: row.messageId, conversationId: row.conversationId!,
      recipientId: row.recipientId ?? null, unsentBy: row.authorId!, unsentAt: row.occurredAt }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId)),
    deletedForMe: view.deletions.map((row) => ({ messageId: row.messageId, conversationId: row.conversationId, deletedAt: row.occurredAt }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId)),
    clears: view.clears.map((row) => ({ conversationId: row.conversationId, throughSequence: row.throughSequence, clearedAt: row.occurredAt }))
      .sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
  };
}

/** Pure merge; caller commits all resulting canonical records in one strict transaction. */
export function mergePortable(view: PortableView, incoming: HistorySnapshot, scope: MessagingScope): PortableView {
  const messages = new Map(view.messages.map((row) => [row.id, row]));
  const conversations = new Map(view.conversations.map((row) => [row.conversationId, row]));
  const unsends = new Map(view.unsends.map((row) => [row.messageId, row]));
  const deletions = new Map(view.deletions.map((row) => [row.messageId, row]));
  const clears = new Map(view.clears.map((row) => [row.conversationId, row]));
  const claimed = new Map(incoming.messages.map((row) => [row.id, row]));
  const ensure = (id: string, peerId?: string) => {
    const prior = conversations.get(id) ?? { conversationId: id, readThrough: 0, updatedAt: 0 };
    if (peerId && prior.peerId && peerId !== prior.peerId) conflict();
    const state = { ...prior, ...(peerId ? { peerId } : {}) };
    conversations.set(id, state); return state;
  };
  // Bind historical peers too, including databases predating the index.
  for (const row of view.messages) ensure(row.conversationId, conversationPeer(scope, row));
  for (const row of incoming.conversations) {
    const state = ensure(row.id), prior = state.snapshot;
    state.snapshot = { id: row.id, lastSequence: Math.max(prior?.lastSequence ?? 0, row.lastSequence),
      createdAt: prior ? Math.min(prior.createdAt, row.createdAt) : row.createdAt,
      updatedAt: Math.max(prior?.updatedAt ?? 0, row.updatedAt) };
    state.updatedAt = Math.max(state.updatedAt, row.updatedAt);
  }
  for (const row of incoming.tombstones) {
    const state: PortableErasure = { kind: "UNSEND", local: true, messageId: row.messageId,
      conversationId: row.conversationId, authorId: row.unsentBy, recipientId: row.recipientId, occurredAt: row.unsentAt };
    const local = messages.get(row.messageId), claim = claimed.get(row.messageId);
    for (const message of [local, claim]) {
      if (message && (!erasureMatches(state, message)
        || (message.unsentAt != null && message.unsentAt !== row.unsentAt))) conflict();
    }
    state.recipientId ??= local?.recipientId ?? claim?.recipientId ?? null;
    const prior = unsends.get(row.messageId);
    if (prior && (prior.conversationId !== state.conversationId || prior.authorId !== state.authorId
      || prior.occurredAt !== state.occurredAt
      || (prior.recipientId != null && state.recipientId != null && prior.recipientId !== state.recipientId))) conflict();
    unsends.set(row.messageId, prior ? { ...prior, recipientId: prior.recipientId ?? state.recipientId } : state);
  }
  for (const row of incoming.deletedForMe) {
    const prior = deletions.get(row.messageId);
    if (prior?.conversationId != null && row.conversationId !== null && prior.conversationId !== row.conversationId) conflict();
    deletions.set(row.messageId, { ...(prior ?? { kind: "DELETE_FOR_ME", local: true, messageId: row.messageId }),
      conversationId: prior?.conversationId ?? row.conversationId, occurredAt: prior ? Math.min(prior.occurredAt, row.deletedAt) : row.deletedAt });
  }
  for (const row of incoming.clears) {
    const prior = clears.get(row.conversationId); ensure(row.conversationId);
    clears.set(row.conversationId, { ...prior, conversationId: row.conversationId,
      throughSequence: Math.max(prior?.throughSequence ?? 0, row.throughSequence), occurredAt: Math.max(prior?.occurredAt ?? 0, row.clearedAt) });
  }
  const eventOwners = new Map(view.messages.filter((row) => row.server).map((row) => [row.server!.eventId, row.id]));
  const sequenceOwners = new Map(view.messages.filter((row) => row.server).map((row) => [`${row.conversationId}:${row.server!.sequence}`, row.id]));
  for (const row of incoming.messages) {
    ensure(row.conversationId, conversationPeer(scope, row));
    const prior = messages.get(row.id), tombstone = unsends.get(row.id);
    const eventOwner = eventOwners.get(row.serverEventId), sequenceKey = `${row.conversationId}:${row.serverSequence}`;
    const sequenceOwner = sequenceOwners.get(sequenceKey);
    if ((eventOwner && eventOwner !== row.id) || (sequenceOwner && sequenceOwner !== row.id)) conflict();
    const priorSuppressed = prior?.snapshotSuppressed || prior?.unsentAt !== undefined
      || deletions.has(row.id) || !!tombstone || (prior?.server && prior.server.sequence <= (clears.get(row.conversationId)?.throughSequence ?? 0));
    if (prior && (prior.conversationId !== row.conversationId || prior.authorId !== row.authorId || prior.recipientId !== row.recipientId
      || !compatibleMessageType(prior.messageType, row.messageType)
      || (prior.server && (prior.server.eventId !== row.serverEventId || prior.server.sequence !== row.serverSequence))
      || (!priorSuppressed && row.body !== null && prior.body !== row.body)
      || (prior.unsentAt !== undefined && row.unsentAt !== null && prior.unsentAt !== row.unsentAt))) conflict();
    const knownTime = prior?.snapshotCreatedAt ?? 0, time = row.createdAt ?? 0;
    const unsentAt = prior?.unsentAt ?? row.unsentAt ?? tombstone?.occurredAt;
    messages.set(row.id, { ...prior, id: row.id, conversationId: row.conversationId, authorId: row.authorId, recipientId: row.recipientId,
      body: row.body ?? "", server: { eventId: row.serverEventId, sequence: row.serverSequence },
      ...((row.messageType ?? prior?.messageType) ? { messageType: row.messageType ?? prior?.messageType } : {}),
      ...(unsentAt !== undefined ? { unsentAt } : {}), ...(row.body === null ? { snapshotSuppressed: true as const } : {}),
      snapshotCreatedAt: knownTime === 0 ? time : time === 0 ? knownTime : Math.min(knownTime, time) });
    eventOwners.set(row.serverEventId, row.id); sequenceOwners.set(sequenceKey, row.id);
  }
  for (const row of messages.values()) {
    const tombstone = unsends.get(row.id), deletion = deletions.get(row.id);
    for (const state of [tombstone, deletion]) if (state && !erasureMatches(state, row, row.server?.sequence)) conflict();
    if (tombstone) {
      if (row.unsentAt !== undefined && row.unsentAt !== tombstone.occurredAt) conflict();
      tombstone.recipientId ??= row.recipientId;
      row.unsentAt = tombstone.occurredAt;
    }
    if (row.snapshotSuppressed || row.unsentAt !== undefined || deletion
      || (row.server && row.server.sequence <= (clears.get(row.conversationId)?.throughSequence ?? 0))) {
      row.body = ""; row.snapshotSuppressed = true;
    }
  }
  return { messages: [...messages.values()], conversations: [...conversations.values()],
    unsends: [...unsends.values()], deletions: [...deletions.values()], clears: [...clears.values()] };
}
