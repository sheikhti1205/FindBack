import type { ConversationProjection, ConversationSummary } from "./conversationIndex";
import type { MediaMetadata, MediaState, MediaUploadAttempt } from "./media";
import type { StateChangeEnvelope, StateCursor } from "./stateChanges";

/** Human-to-human text history. Deliberately separate from services/ai/chatStore. */
export interface MessagingScope {
  accountId: string;
  /** Random per-installation UUID, provided by the signed-in session owner. */
  deviceId: string;
}

export type MessageType = "TEXT" | "MEDIA";

export interface HumanMessage {
  /** Stable client-generated UUID: transport retries must preserve it. */
  id: string;
  conversationId: string;
  authorId: string;
  recipientId: string;
  body: string;
  /** Absent only for legacy history whose classification was never received.
   * Never infer TEXT from body or missing attachment metadata. */
  messageType?: MessageType;
}

export interface StoredHumanMessage extends HumanMessage {
  server?: { eventId: string; sequence: number };
  /** Present when the author unsent this message; `body` is then empty. */
  unsentAt?: number;
}

/**
 * One chat attachment. Metadata only: the bytes live in the dedicated
 * `mediaBytes` store on every platform, because the SQLite bridge cannot carry
 * binary. A record never proves its own bytes exist; only the byte store does.
 *
 * `state` is the whole upload/ACK lifecycle and `token`/`leaseUntil` are the
 * lease that fences a stale attempt. They are present exactly while
 * `state === "UPLOADING"`.
 */
export interface MediaAttachment extends MediaMetadata {
  state: MediaState;
  attempts: number;
  /** Least-recently-used ordering for eviction; updated when bytes are read. */
  lastAccessAt: number;
  token?: string;
  leaseUntil?: number;
}

/**
 * The slice of the byte store the history adapters use. Injected so the two
 * durable stores stay independent. Ordering plus the account Web Lock prevents
 * adapter-owned cleanup from deleting bytes owned by a committed record.
 *
 * Trusted dependency contract: for one account, this port's backing database
 * belongs to exactly ONE metadata database (installation + backend). Multiple
 * handles of that same history may share it. Different installations/backends
 * must use different byte databases, even for the same account; otherwise an
 * orphan sweep cannot know the other history's live set. The platform owner is
 * responsible for choosing that database and closing it after history drains.
 */
export interface MediaBytesPort {
  /** Rejects rather than evicting when the account budget is full. */
  put(accountId: string, attachmentId: string, bytes: ArrayBuffer): Promise<void>;
  get(accountId: string, attachmentId: string): Promise<ArrayBuffer | null>;
  has(accountId: string, attachmentId: string): Promise<boolean>;
  delete(accountId: string, attachmentIds: readonly string[]): Promise<void>;
  keys(accountId: string): Promise<string[]>;
  /** Removes entries whose id is not in `keep`, bounded by `limit`. */
  sweep(accountId: string, keep: ReadonlySet<string>, limit: number): Promise<number>;
  clearAccount(accountId: string): Promise<void>;
}

/**
 * A verified inbound attachment whose parent message is not visible here yet.
 * The caller defers and retries after the text sync; it must never ACK, and no
 * row or byte was written.
 */
export class MediaParentUnavailableError extends Error {
  constructor(readonly messageId: string) {
    super("Media parent is not available");
    this.name = "MediaParentUnavailableError";
  }
}

export interface OutboxEntry {
  messageId: string;
  /** NEEDS_REVIEW is the durable unknown-classification quarantine projected
   * from the parent, not a retryable transport failure. Wake/flush skips it;
   * authority or explicit matching text/media admission can resolve it. */
  status: "QUEUED" | "SENDING" | "FAILED" | "NEEDS_REVIEW";
  attempts: number;
  token?: string;
  leaseUntil?: number;
  /** Opaque relationship epoch observed when the send was queued. It is part of
   * the queued intent, not of the message, so a restart cannot re-bind an older
   * send to a newer request/connection boundary. */
  expectedEpoch?: string;
}

export interface OutgoingAttempt {
  message: HumanMessage;
  token: string;
  attempt: number;
  /** The boundary this queued send observed; absent only for legacy rows. */
  expectedEpoch?: string;
}

/**
 * MUST come from a participant-authorized transport validator, not push payloads.
 * This local boundary checks shape/scope/idempotency, not server authorization.
 * Sequence is authoritative per conversation, never a timestamp or ACK cursor.
   * TEXT is the legacy transport event kind, not the message classification.
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
 * `body: null` means suppressed (unsent or deleted-for-me). `body: ""` is a
 * legitimate body: an image-only message has no caption (SQLite v5 relaxed the
 * `messages` CHECK so `''` is storable, and the web adapter stores `""` too).
 * Neither adapter may collapse one into the other: suppression is carried by
 * `unsentAt`/`deletedForMe`/`clears`, not by the empty string.
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
  /** NULL/absent means legacy unknown; suppression never erases classification. */
  messageType?: MessageType | null;
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
  /** `expectedEpoch` is the cached relationship boundary the caller observed;
   * the server refuses a new send that no longer matches it. */
  enqueueOutgoing(message: HumanMessage, expectedEpoch?: string): Promise<void>;
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
  /**
   * A 60-second durable lease; expired SENDING is eligible after crash/reopen.
   * `except` lets one flush pass walk past rows it already failed, so a single
   * undeliverable message cannot starve the rest of the queue.
   */
  claimNextOutgoing(except?: readonly string[]): Promise<OutgoingAttempt | null>;
  /**
   * Explicit user retry only. Rebinds a queued/failed row to the boundary the
   * user is acting in and makes it claimable again; the flush loop must never
   * call this, because silently re-binding stale intent is exactly what the
   * relationship epoch exists to prevent.
   */
  retryOutgoing(messageId: string, expectedEpoch: string): Promise<boolean>;
  /** A late failure cannot overwrite a newer attempt or authoritative success. */
  failOutgoing(attempt: OutgoingAttempt): Promise<boolean>;
  /** Requires accepted strict write durability, then transaction completion. Echo confirms sent. */
  persistInbound(envelope: MailboxEnvelope): Promise<PersistenceReceipt>;
  persistInboundAndAck(envelope: MailboxEnvelope, ack: (receipt: PersistenceReceipt) => Promise<void>): Promise<void>;
  /**
   * The single durable outbound media admission point. Validates scope, parent,
   * cached CONNECTED eligibility, digest, size, budget and suppression. Writes bytes first, then the
   * message, outbox and attachment in one history transaction, and resolves only
   * after both commits. Rejection gives no success/ACK guarantee: a lost COMMIT
   * response can leave committed pending work. Reconcile/retry the same IDs;
   * only a positively acknowledged rollback permits new-byte compensation.
   * An unknown transaction outcome invalidates the SQLite handle; reopen it.
   */
  enqueueOutgoingWithMedia(message: HumanMessage, metadata: MediaMetadata, bytes: ArrayBuffer,
    expectedEpoch?: string): Promise<void>;
  /**
   * The only upload claim. Never returns an attachment whose bytes are absent,
   * whose parent is invisible, or whose text echo has not landed yet.
   */
  claimNextMediaUpload(): Promise<MediaUploadAttempt | null>;
  /** Token+attempt compare-and-set; a stale attempt can never change a newer one. */
  failMediaUpload(attempt: MediaUploadAttempt): Promise<boolean>;
  /** Upload finished: `UPLOADING` -> `AWAITING_ACK`, fenced by token+attempt. */
  completeMediaUpload(attempt: MediaUploadAttempt): Promise<boolean>;
  /**
   * The single inbound enforcement point. Independently verifies digest, exact
   * length, MIME and immutable identity, requires a visible parent, commits the
   * bytes then metadata as `AWAITING_ACK`. Rechecks live row, purge fence,
   * visible parent, stored bytes and open state before callback entry under the
   * account lock. Async callback completion is outside the lock/local queue so
   * it may reenter history. The callback must start scope-bound work at entry
   * and honor the owner's abort signal; already-entered work is not recalled.
   * ACK failure keeps bytes protected unless another operation suppressed them;
   * successful ACK marks an extant record `READY`, never recreates a removed row.
   */
  persistVerifiedMediaAndAck(
    metadata: MediaMetadata,
    verifiedBytes: ArrayBuffer,
    ack: (attachment: MediaAttachment) => Promise<void>,
  ): Promise<void>;
  /** Visible attachments for one conversation, in authoritative message order. */
  listMedia(conversationId: string): Promise<MediaAttachment[]>;
  /** Committed bytes, or `null`. Never a partial value; a read updates LRU order. */
  readMedia(attachmentId: string): Promise<ArrayBuffer | null>;
  /** Marks an acknowledged attachment `READY`; idempotent for a late replay. */
  markMediaReady(attachmentId: string): Promise<boolean>;
  /**
   * Least-recently-used eviction of `READY` records only. The row is marked
   * `EVICTED` before its bytes are deleted, so a crash leaves sweepable bytes
   * rather than a row claiming bytes that are gone.
   */
  evictMedia(limit: number): Promise<number>;
  /** Bounded orphan sweep across both stores; returns the entries removed. */
  sweepOrphanMedia(limit: number): Promise<number>;
  /** Local personal deletion, then byte cleanup. An expected pending conversation
   * requires an own, not-yet-echoed parent in that conversation at transaction
   * time; a raced server echo rejects before erasure. Already hidden is a no-op.
   * This does not retract a send already admitted by the remote server. */
  removeMediaForMessage(messageId: string, pendingConversationId?: string): Promise<void>;
  /** Media-only purge; retains text/history. Not full account deletion. */
  clearMedia(): Promise<void>;
  /** Permanent logical purge of this metadata database and captured-account
   * bytes (requires its byte port). Commits a full-history fence and removes all
   * content/index/receipt/backup-source rows before clearing/verifying bytes.
   * Ordinary operations then refuse across handles/reopen; purge retry and close
   * remain available. Failure is not completion. This is not SQLite/WAL forensic
   * erasure or an all-scopes account-deletion owner; platform/registry owns that. */
  purgeHistory(): Promise<void>;
  /** Portable history data for a backup. Never includes mailbox receipts, the
   * outbox or per-device read state. */
  exportSnapshot(): Promise<HistorySnapshot>;
  /** Merge a normalised snapshot in one transaction. Never creates send work,
   * mailbox receipts or state events, and never resurrects a suppressed body. */
  importSnapshot(snapshot: HistorySnapshot): Promise<ImportReport>;
  /** Session owner must close on sign-out/account switch; cancels active work. */
  close(): void | Promise<void>;
}
