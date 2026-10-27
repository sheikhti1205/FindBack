import type { ConversationProjection, ConversationSummary } from "./conversationIndex";
import type { StateChangeEnvelope, StateCursor } from "./stateChanges";

/** Human-to-human text history. Deliberately separate from services/ai/chatStore. */
export interface MessagingScope {
  accountId: string;
  /** Random per-installation UUID, provided by the signed-in session owner. */
  deviceId: string;
}

export interface HumanMessage {
  /** Stable client-generated UUID: transport retries must preserve it. */
  id: string;
  conversationId: string;
  authorId: string;
  recipientId: string;
  body: string;
}

export interface StoredHumanMessage extends HumanMessage {
  server?: { eventId: string; sequence: number };
  /** Present when the author unsent this message; `body` is then empty. */
  unsentAt?: number;
}

export interface OutboxEntry {
  messageId: string;
  status: "QUEUED" | "SENDING" | "FAILED";
  attempts: number;
  token?: string;
  leaseUntil?: number;
}

export interface OutgoingAttempt {
  message: HumanMessage;
  token: string;
  attempt: number;
}

/**
 * MUST come from a participant-authorized transport validator, not push payloads.
 * This local boundary checks shape/scope/idempotency, not server authorization.
 * Sequence is authoritative per conversation, never a timestamp or ACK cursor.
 * Only TEXT is supported; tombstones/clear/read/media are explicitly not applied.
 */
export interface MailboxEnvelope extends MessagingScope {
  mailboxId: string;
  event: {
    kind: "TEXT";
    eventId: string;
    sequence: number;
    message: HumanMessage;
  };
}

export interface PersistenceReceipt extends MessagingScope {
  mailboxId: string;
  eventId: string;
}

/**
 * Portable history data. Deliberately plain: no adapter, no device identity and
 * no cursor. A restore must never claim to have applied metadata it does not
 * have, so the state cursor is not part of a backup.
 *
 * `body: null` means suppressed (unsent or deleted-for-me). An empty string is
 * not a valid body, so the two adapters — which store suppression as NULL and
 * as `""` respectively — normalise to this one representation.
 */
export interface SnapshotConversation {
  id: string;
  lastSequence: number;
  /** Non-null: both SQLite columns are NOT NULL, and web exports no conversations. */
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotMessage {
  id: string;
  conversationId: string;
  authorId: string;
  recipientId: string;
  body: string | null;
  /** Only accepted messages are portable; a pending send is not history. */
  serverEventId: string;
  serverSequence: number;
  unsentAt: number | null;
  /** `null` when the adapter never observed one; 0 means unknown after normalisation. */
  createdAt: number | null;
}

export interface HistorySnapshot {
  conversations: SnapshotConversation[];
  messages: SnapshotMessage[];
  tombstones: { messageId: string; conversationId: string; recipientId: string | null;
    unsentAt: number; unsentBy: string }[];
  deletedForMe: { messageId: string; conversationId: string | null; deletedAt: number }[];
  clears: { conversationId: string; throughSequence: number; clearedAt: number }[];
}

export interface ImportReport {
  conversations: number;
  messages: number;
  tombstones: number;
  deletedForMe: number;
  clears: number;
}

/** Canonical account/device-local history on SQLite or IndexedDB. */
export interface MessagingHistory {
  enqueueOutgoing(message: HumanMessage): Promise<void>;
  getMessage(id: string): Promise<StoredHumanMessage | null>;
  listMessages(conversationId: string): Promise<StoredHumanMessage[]>;
  /** Local inbox remains enumerable offline, including cached relationship rows. */
  listConversations(): Promise<ConversationSummary[]>;
  cacheConversation(projection: ConversationProjection): Promise<void>;
  /** Local reading is independent of whether public read receipts are enabled. */
  markConversationRead(conversationId: string, throughSequence: number): Promise<void>;
  /** Body-free erasure metadata survives temporary message-mailbox expiry. */
  getStateCursor(): Promise<StateCursor | null>;
  applyStateChange(envelope: StateChangeEnvelope): Promise<StateCursor>;
  listOutbox(): Promise<OutboxEntry[]>;
  /** A 60-second durable lease; expired SENDING is eligible after crash/reopen. */
  claimNextOutgoing(): Promise<OutgoingAttempt | null>;
  /** A late failure cannot overwrite a newer attempt or authoritative success. */
  failOutgoing(attempt: OutgoingAttempt): Promise<boolean>;
  /** Requires accepted strict write durability, then transaction completion. Echo confirms sent. */
  persistInbound(envelope: MailboxEnvelope): Promise<PersistenceReceipt>;
  persistInboundAndAck(envelope: MailboxEnvelope, ack: (receipt: PersistenceReceipt) => Promise<void>): Promise<void>;
  /** Portable history data for a backup. Never includes mailbox receipts, the
   * outbox or per-device read state. */
  exportSnapshot(): Promise<HistorySnapshot>;
  /** Merge a normalised snapshot in one transaction. Never creates send work,
   * mailbox receipts or state events, and never resurrects a suppressed body. */
  importSnapshot(snapshot: HistorySnapshot): Promise<ImportReport>;
  /** Session owner must close on sign-out/account switch; cancels active work. */
  close(): void | Promise<void>;
}
