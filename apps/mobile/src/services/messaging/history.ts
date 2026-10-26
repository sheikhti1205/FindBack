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

/** Storage contract for an eventual SQLite adapter; no platform auto-selection. */
export interface MessagingHistory {
  enqueueOutgoing(message: HumanMessage): Promise<void>;
  getMessage(id: string): Promise<StoredHumanMessage | null>;
  listMessages(conversationId: string): Promise<StoredHumanMessage[]>;
  listOutbox(): Promise<OutboxEntry[]>;
  /** A 60-second durable lease; expired SENDING is eligible after crash/reopen. */
  claimNextOutgoing(): Promise<OutgoingAttempt | null>;
  /** A late failure cannot overwrite a newer attempt or authoritative success. */
  failOutgoing(attempt: OutgoingAttempt): Promise<boolean>;
  /** Requires accepted strict write durability, then transaction completion. Echo confirms sent. */
  persistInbound(envelope: MailboxEnvelope): Promise<PersistenceReceipt>;
  persistInboundAndAck(envelope: MailboxEnvelope, ack: (receipt: PersistenceReceipt) => Promise<void>): Promise<void>;
  /** Session owner must close on sign-out/account switch; cancels active work. */
  close(): void;
}
