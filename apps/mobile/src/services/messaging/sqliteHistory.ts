/**
 * Android-side local history adapter over an injected SQLite driver (R3 §7–§10).
 *
 * The driver is injected so this module never imports a Node-only or native
 * binding; the Capacitor SQLite bridge supplies an asynchronous driver. Tests execute the
 * real statements against a real SQLite engine, which proves the schema and SQL —
 * not Android device behaviour, the bridge, or power-loss durability.
 *
 * Driver precondition: a durable, file-backed connection. `open()` rejects an
 * in-memory database or any connection where WAL/FULL/foreign-keys did not take
 * effect, because a persistence receipt is only honest after a durable commit.
 */
import type {
  HistorySnapshot, HumanMessage, ImportReport, MailboxEnvelope, MessagingHistory,
  MessagingScope, OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage,
} from "./history";
import { BackupError, normaliseSnapshot, validateSnapshot } from "./backup";
import {
  MESSAGING_SQLITE_DURABILITY_CHECKS as D,
  MESSAGING_SQLITE_PRAGMAS,
  MESSAGING_SQLITE_SCHEMA,
  MESSAGING_SQLITE_SCHEMA_VERSION,
  MESSAGING_SQLITE_STATEMENTS as S,
} from "./sqliteSchema";
import {
  conversationPeer, copyConversationProjection, nonnegativeSequence, summarizeConversations,
  type ConversationProjection, type ConversationSummary, type LocalConversationState,
} from "./conversationIndex";
import { copyStateEnvelope, statePeer, type StateChangeEnvelope, type StateCursor } from "./stateChanges";
import { copyMessage, positiveSequence, uuid } from "./validation";

export type SqliteValue = string | number | null;

export interface SqliteDriver {
  exec(sql: string): void | Promise<void>;
  all<T = Record<string, SqliteValue>>(sql: string, params?: readonly SqliteValue[]): T[] | Promise<T[]>;
  /** Returns the number of changed rows. */
  run(sql: string, params?: readonly SqliteValue[]): number | Promise<number>;
  close(): void | Promise<void>;
}

export interface SqliteHistoryOptions {
  now?: () => number;
  /** Lease length; the web adapter uses 60s and both must stay comparable. */
  leaseMs?: number;
  /** Injected randomness so a platform without `crypto.randomUUID` still works. */
  token?: () => string;
  /** Test/initialisation override for the busy timeout. */
  busyTimeoutMs?: number;
}

interface MessageRow {
  id: string;
  conversationId: string;
  authorId: string;
  recipientId: string;
  body: string | null;
  eventId: string | null;
  sequence: number | null;
  unsentAt: number | null;
}

interface OutboxRow {
  messageId: string;
  status: OutboxEntry["status"];
  attempts: number;
  token: string | null;
  leaseUntil: number | null;
}

interface TombstoneRow {
  messageId: string;
  conversationId: string;
  /** NULL only for tombstones written by a pre-v4 schema. */
  recipientId: string | null;
  unsentAt: number;
  unsentBy: string;
}

const LEASE_MS = 60_000;

function defaultToken(): string {
  const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!source?.randomUUID) throw new Error("Messaging token source unavailable; inject options.token");
  return source.randomUUID();
}

function toStored(row: MessageRow): StoredHumanMessage {
  const stored: StoredHumanMessage = {
    id: row.id,
    conversationId: row.conversationId,
    authorId: row.authorId,
    recipientId: row.recipientId,
    body: row.body ?? "",
  };
  if (row.eventId !== null && row.sequence !== null) {
    stored.server = { eventId: row.eventId, sequence: row.sequence };
  }
  if (row.unsentAt !== null) stored.unsentAt = row.unsentAt;
  return stored;
}

/** Immutable identity fields. Body is checked separately because unsend erases it. */
function sameIdentity(row: MessageRow, message: HumanMessage): boolean {
  return row.conversationId === message.conversationId
    && row.authorId === message.authorId
    && row.recipientId === message.recipientId;
}

function positiveTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid messaging timestamp");
  }
  return value;
}

/**
 * The SQLite adapter's own surface: the portable history contract plus the
 * local-only erasure operations and a close that releases the driver.
 */
export type SqliteMessagingHistory = MessagingHistory & {
  recordUnsend(tombstone: {
    messageId: string; conversationId: string; recipientId: string;
    unsentAt: number; unsentBy: string;
  }): Promise<void>;
  deleteForMe(messageId: string): Promise<void>;
  clearThrough(conversationId: string, throughSequence: number): Promise<void>;
  close(): Promise<void>;
};

export async function openSqliteMessagingHistory(
  driver: SqliteDriver,
  identity: MessagingScope,
  options: SqliteHistoryOptions = {},
): Promise<SqliteMessagingHistory> {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  // The driver is already open and this function owns closing it on failure, so
  // an invalid identity must not leak the native handle.
  let scope: MessagingScope;
  try {
    scope = { accountId: uuid(identity?.accountId), deviceId: uuid(identity?.deviceId) };
  } catch (error) {
    await driver.close();
    throw error;
  }
  if (typeof leaseMs !== "number" || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    await driver.close();
    throw new Error("Invalid messaging lease duration");
  }
  const tokenFactory = options.token ?? defaultToken;
  let closed = false;

  try {
  // Read the existing binding before touching journal mode or creating tables.
  // In particular, a future schema version must be rejected without mutating
  // its file into a v1-shaped database. A fresh file has no metadata table yet.
  const metaTable = (await driver.all<{ name: string }>(
    "select name from sqlite_master where type = 'table' and name = 'messaging_meta'",
  ))[0];
  if (metaTable) {
    const prior = new Map(
      (await driver.all<{ key: string; value: string }>(S.getMetaRows)).map((row) => [row.key, row.value]),
    );
    const storedVersion = prior.get("schema_version") ?? null;
    if (storedVersion !== null && !["1", "2", "3", String(MESSAGING_SQLITE_SCHEMA_VERSION)].includes(storedVersion)) {
      throw new Error("Unsupported messaging schema version");
    }
    const storedAccount = prior.get("account_id") ?? null;
    const storedDevice = prior.get("device_id") ?? null;
    if (storedAccount !== null && storedAccount !== scope.accountId) {
      throw new Error("Messaging database belongs to a different account");
    }
    if (storedDevice !== null && storedDevice !== scope.deviceId) {
      throw new Error("Messaging database belongs to a different installation");
    }
  }

  for (const pragma of MESSAGING_SQLITE_PRAGMAS) await driver.exec(pragma);
  if (options.busyTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
      throw new Error("Invalid messaging busy timeout");
    }
    await driver.exec(`pragma busy_timeout = ${options.busyTimeoutMs}`);
  }

  // Verify durability instead of assuming the pragmas applied.
  const journalMode = (await driver.all<{ journal_mode: string }>(D.journalMode))[0]?.journal_mode;
  const synchronous = (await driver.all<{ synchronous: number }>(D.synchronous))[0]?.synchronous;
  const foreignKeys = (await driver.all<{ foreign_keys: number }>(D.foreignKeys))[0]?.foreign_keys;
  if (journalMode !== "wal") {
    throw new Error("Messaging storage requires a durable file-backed database with WAL journal mode");
  }
  if (synchronous !== 2) {
    throw new Error("Messaging storage requires synchronous = FULL");
  }
  if (foreignKeys !== 1) {
    throw new Error("Messaging storage requires foreign_keys = ON");
  }

  for (const statement of MESSAGING_SQLITE_SCHEMA) await driver.exec(statement);

  // Additive v1-v3 -> v4 migration: a pre-v4 tombstones table has no recipient
  // binding. `pragma table_info` makes this idempotent; the DDL runs before the
  // binding transaction so a failure still closes the handle.
  const tombstoneColumns = await driver.all<{ name: string }>(S.tombstoneColumns);
  if (!tombstoneColumns.some((column) => column.name === "recipient_id")) {
    await driver.exec(S.addTombstoneRecipient);
  }

  // Bind account + installation + schema version under one write lock. Checking
  // outside the transaction (or overwriting an existing binding) lets two
  // initializers end up sharing one file under different identities.
  await driver.exec("begin immediate");
  try {
    const binding = new Map(
      (await driver.all<{ key: string; value: string }>(S.getMetaRows)).map((row) => [row.key, row.value]),
    );
    const storedAccount = binding.get("account_id") ?? null;
    const storedDevice = binding.get("device_id") ?? null;
    const storedVersion = binding.get("schema_version") ?? null;
    if (storedVersion !== null && !["1", "2", "3", String(MESSAGING_SQLITE_SCHEMA_VERSION)].includes(storedVersion)) {
      throw new Error("Unsupported messaging schema version");
    }
    if (storedAccount !== null && storedAccount !== scope.accountId) {
      throw new Error("Messaging database belongs to a different account");
    }
    if (storedDevice !== null && storedDevice !== scope.deviceId) {
      throw new Error("Messaging database belongs to a different installation");
    }
    await driver.run(S.setMetaIfAbsent, ["account_id", scope.accountId]);
    await driver.run(S.setMetaIfAbsent, ["device_id", scope.deviceId]);
    await driver.run(S.setMetaIfAbsent, ["schema_version", String(MESSAGING_SQLITE_SCHEMA_VERSION)]);
    // Additive v1/v2 -> v3 migration. Upgrade metadata under the same lock as
    // identity binding; existing messages, outbox and tombstones are preserved.
    await driver.run(S.setSchemaVersion, [String(MESSAGING_SQLITE_SCHEMA_VERSION)]);
    const confirmed = new Map(
      (await driver.all<{ key: string; value: string }>(S.getMetaRows)).map((row) => [row.key, row.value]),
    );
    if (confirmed.get("account_id") !== scope.accountId || confirmed.get("device_id") !== scope.deviceId) {
      throw new Error("Messaging database binding conflict");
    }
    await driver.exec("commit");
  } catch (error) {
    try { await driver.exec("rollback"); } catch { /* transaction may already be gone */ }
    throw error;
  }
  } catch (error) {
    await driver.close();
    throw error;
  }

  async function assertOpen() {
    if (closed) throw new Error("Messaging history closed");
    const binding = new Map(
      (await driver.all<{ key: string; value: string }>(S.getMetaRows)).map((row) => [row.key, row.value]),
    );
    if (closed) throw new Error("Messaging history closed");
    if (binding.get("account_id") !== scope.accountId || binding.get("device_id") !== scope.deviceId) {
      throw new Error("Messaging database binding conflict");
    }
  }

  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    await driver.exec("begin immediate");
    try {
      const result = await work();
      if (closed) throw new Error("Messaging history closed");
      await driver.exec("commit");
      if (closed) throw new Error("Messaging history closed");
      return result;
    } catch (error) {
      try { await driver.exec("rollback"); } catch { /* commit may already have failed */ }
      throw error;
    }
  }

  async function messageRow(id: string): Promise<MessageRow | undefined> {
    return (await driver.all<MessageRow>(S.getMessage, [id]))[0];
  }

  async function tombstoneRow(id: string): Promise<TombstoneRow | undefined> {
    return (await driver.all<TombstoneRow>(S.getTombstone, [id]))[0];
  }

  async function touch(conversationId: string, sequence: number) {
    await driver.run(S.insertConversation, [conversationId, now(), now()]);
    await driver.run(S.touchConversation, [sequence, now(), conversationId]);
  }

  async function ensureConversation(conversationId: string) {
    await driver.run(S.insertConversation, [conversationId, now(), now()]);
  }

  interface StateRow {
    conversationId: string; peerId: string; readThrough: number; updatedAt: number;
    projectionJson: string | null; observedAt: number | null;
  }

  function localState(row: StateRow): LocalConversationState {
    return { conversationId: row.conversationId, peerId: row.peerId,
      readThrough: row.readThrough, updatedAt: row.updatedAt,
      ...(row.projectionJson === null ? {} : {
        projection: copyConversationProjection(JSON.parse(row.projectionJson) as ConversationProjection),
        observedAt: row.observedAt ?? undefined,
      }) };
  }

  async function ensureConversationState(conversationId: string, peerId: string) {
    if (peerId === scope.accountId) throw new Error("Conversation peer scope mismatch");
    await ensureConversation(conversationId);
    const participants = await driver.all<{ authorId: string; recipientId: string }>(S.getConversationParticipants, [conversationId]);
    for (const pair of participants) {
      if (conversationPeer(scope, pair) !== peerId) throw new Error("Immutable conversation peer conflict");
    }
    await driver.run(S.insertConversationState, [conversationId, peerId]);
    const row = (await driver.all<StateRow>(S.getConversationState, [conversationId]))[0];
    if (!row || row.peerId !== peerId) throw new Error("Immutable conversation peer conflict");
    return row;
  }

  /**
   * Exact match only. A tombstone with a NULL recipient is *unbound*, not a
   * wildcard: callers must resolve it with `bindLegacyTombstone` first, so an
   * unbound v3 row can never erase a different recipient's message.
   */
  function assertTombstoneIdentity(tombstone: TombstoneRow, message: HumanMessage) {
    if (tombstone.conversationId !== message.conversationId
      || tombstone.unsentBy !== message.authorId
      || tombstone.recipientId !== message.recipientId) {
      throw new Error("Unsend identity conflict");
    }
  }

  /**
   * A tombstone may only suppress the message it actually describes. The
   * anti-resurrection backstop matches on message id alone, so without this an
   * imported (or resealed) tombstone could erase a message with the same id but a
   * different author, conversation or recipient. An unbound legacy recipient is
   * still allowed, because it carries no claim to contradict.
   */
  function assertSnapshotTombstone(tombstone: {
    conversationId: string; recipientId: string | null; unsentAt: number; unsentBy: string;
  }, message: {
    conversationId: string; authorId: string; recipientId: string; unsentAt: number | null;
  }) {
    if (tombstone.conversationId !== message.conversationId
      || tombstone.unsentBy !== message.authorId
      || (tombstone.recipientId !== null && tombstone.recipientId !== message.recipientId)
      // Two known unsend times that disagree describe different events.
      || (message.unsentAt !== null && message.unsentAt !== tombstone.unsentAt)) {
      throw new BackupError("backup: identity conflict");
    }
  }

  /**
   * A v3 tombstone recorded conversation and author but no recipient. The first
   * authoritative record of the message supplies it, inside the caller's
   * transaction: the stored row when the message still exists locally, otherwise
   * the server envelope being applied. Without this the NULL stayed NULL forever
   * and matched every recipient.
   */
  async function bindLegacyTombstone(tombstone: TombstoneRow, recipientId: string): Promise<TombstoneRow> {
    if (tombstone.recipientId !== null) return tombstone;
    await driver.run(S.bindTombstoneRecipient, [recipientId, tombstone.messageId]);
    return { ...tombstone, recipientId };
  }

  async function enqueueOutgoing(message: HumanMessage): Promise<void> {
    const outgoing = copyMessage(message);
    await assertOpen();
    if (outgoing.authorId !== scope.accountId) {
      throw new Error("Outgoing messaging scope mismatch");
    }
    await transaction(async () => {
      await ensureConversationState(outgoing.conversationId, conversationPeer(scope, outgoing));
      const storedTombstone = await tombstoneRow(outgoing.id);
      const tombstone = storedTombstone
        ? await bindLegacyTombstone(storedTombstone, outgoing.recipientId)
        : null;
      if (tombstone) assertTombstoneIdentity(tombstone, outgoing);

      const existing = await messageRow(outgoing.id);
      if (existing) {
        if (!sameIdentity(existing, outgoing)) throw new Error("Immutable message identity conflict");
        if (existing.body !== null && existing.body !== outgoing.body) {
          throw new Error("Conflicting messaging message");
        }
        if (tombstone && existing.body !== null) {
          await driver.run(S.clearMessageBody, [tombstone.unsentAt, outgoing.id]);
        }
        return;
      }
      if (tombstone) {
        // An authoritative unsend already exists: keep the identity, never the body,
        // and never queue an erased message for delivery.
        await driver.run(S.insertTombstonedMessage, [
          outgoing.id, outgoing.conversationId, outgoing.authorId, outgoing.recipientId,
          now(), tombstone.unsentAt,
        ]);
        return;
      }
      await driver.run(S.insertMessage, [
        outgoing.id, outgoing.conversationId, outgoing.authorId, outgoing.recipientId, outgoing.body, now(),
      ]);
      await driver.run(S.enqueueOutbox, [outgoing.id]);
      await driver.run(S.touchConversationState, [now(), outgoing.conversationId]);
    });
  }

  async function getMessage(id: string): Promise<StoredHumanMessage | null> {
    await assertOpen();
    const row = (await driver.all<MessageRow>(S.getVisibleMessage, [uuid(id)]))[0];
    return row ? toStored(row) : null;
  }

  async function listMessages(conversationId: string): Promise<StoredHumanMessage[]> {
    await assertOpen();
    return (await driver.all<MessageRow>(S.listMessages, [uuid(conversationId)])).map(toStored);
  }

  async function listOutbox(): Promise<OutboxEntry[]> {
    await assertOpen();
    return (await driver.all<OutboxRow>(S.listOutbox)).map((row) => {
      const entry: OutboxEntry = { messageId: row.messageId, status: row.status, attempts: row.attempts };
      if (row.token !== null) entry.token = row.token;
      if (row.leaseUntil !== null) entry.leaseUntil = row.leaseUntil;
      return entry;
    });
  }

  async function listConversations(): Promise<ConversationSummary[]> {
    await assertOpen();
    return summarizeConversations(scope,
      (await driver.all<StateRow>(S.listConversationStates)).map(localState),
      (await driver.all<MessageRow>(S.listInboxMessages)).map(toStored), await listOutbox());
  }

  async function cacheConversation(input: ConversationProjection): Promise<void> {
    const projection = copyConversationProjection(input);
    await assertOpen();
    await transaction(async () => {
      const row = await ensureConversationState(projection.conversationId, projection.peerId);
      const prior = localState(row).projection;
      if (prior && prior.revision > projection.revision) return;
      if (prior?.revision === projection.revision && JSON.stringify(prior) !== JSON.stringify(projection)) {
        throw new Error("Conversation revision conflict");
      }
      await driver.run(S.cacheConversation, [JSON.stringify(projection), now(), projection.conversationId]);
    });
  }

  async function markConversationRead(conversationId: string, throughSequence: number): Promise<void> {
    const id = uuid(conversationId);
    const through = nonnegativeSequence(throughSequence);
    await assertOpen();
    await transaction(async () => {
      const highest = (await driver.all<{ sequence: number }>(S.maxConversationSequence, [id]))[0]?.sequence ?? 0;
      if (through > highest) throw new Error("Cannot read beyond local history");
      const pair = (await driver.all<{ authorId: string; recipientId: string }>(S.getConversationParticipants, [id]))[0];
      if (pair) await ensureConversationState(id, conversationPeer(scope, pair));
      await driver.run(S.markConversationRead, [through, id]);
    });
  }

  async function claimNextOutgoing(): Promise<OutgoingAttempt | null> {
    await assertOpen();
    const token = tokenFactory();
    if (typeof token !== "string" || !token) throw new Error("Invalid messaging lease token");
    return transaction(async () => {
      const nowMs = positiveTimestamp(now());
      const candidate = (await driver.all<{ messageId: string }>(S.nextOutbox, [nowMs]))[0];
      if (!candidate) return null;
      await driver.run(S.claimOutbox, [token, nowMs + leaseMs, candidate.messageId]);
      const claimed = (await driver.all<{ messageId: string; attempts: number }>(S.getOutboxClaim, [candidate.messageId]))[0];
      if (!claimed) return null;
      const row = await messageRow(claimed.messageId);
      if (!row || row.body === null || row.unsentAt !== null || row.eventId !== null) {
        throw new Error("Messaging outbox identity conflict");
      }
      const attempt: OutgoingAttempt = {
        message: {
          id: row.id, conversationId: row.conversationId, authorId: row.authorId,
          recipientId: row.recipientId, body: row.body,
        },
        token,
        attempt: claimed.attempts,
      };
      return attempt;
    });
  }

  async function failOutgoing(attempt: OutgoingAttempt): Promise<boolean> {
    await assertOpen();
    const message = copyMessage(attempt?.message);
    if (message.authorId !== scope.accountId) throw new Error("Invalid outgoing attempt scope");
    if (!Number.isSafeInteger(attempt?.attempt) || attempt.attempt < 1) {
      throw new Error("Invalid outgoing attempt generation");
    }
    const token = attempt.token;
    if (typeof token !== "string" || !token) throw new Error("Invalid messaging lease token");
    return transaction(async () => {
      const row = await messageRow(message.id);
      if (!row || !sameIdentity(row, message)) throw new Error("Outgoing attempt identity conflict");
      if (row.body === null) return false;
      // A failure must describe the exact immutable message that was leased.
      if (row.body !== message.body) throw new Error("Outgoing attempt identity conflict");
      return (await driver.run(S.failOutbox, [message.id, token, attempt.attempt])) === 1;
    });
  }

  function assertEnvelopeScope(envelope: MailboxEnvelope) {
    if (!envelope || envelope.accountId !== scope.accountId || envelope.deviceId !== scope.deviceId) {
      throw new Error("Messaging envelope is outside this installation scope");
    }
  }

  async function persist(envelope: MailboxEnvelope): Promise<PersistenceReceipt> {
    assertEnvelopeScope(envelope);
    const mailboxId = uuid(envelope.mailboxId);
    const eventId = uuid(envelope.event?.eventId);
    const sequence = positiveSequence(envelope.event?.sequence);
    if (envelope.event?.kind !== "TEXT") throw new Error("Unsupported messaging event");
    const message = copyMessage(envelope.event.message);
    if (message.authorId !== scope.accountId && message.recipientId !== scope.accountId) {
      throw new Error("Inbound participant scope mismatch");
    }

    return transaction(async () => {
      const mailbox = (await driver.all<{ eventId: string; messageId: string; sequence: number }>(
        S.getMailboxEvent, [mailboxId],
      ))[0];
      if (mailbox && (mailbox.eventId !== eventId || mailbox.messageId !== message.id || mailbox.sequence !== sequence)) {
        throw new Error("Immutable mailbox identity conflict");
      }
      const byEvent = (await driver.all<MessageRow>(S.getMessageByEvent, [eventId]))[0];
      if (byEvent && (byEvent.id !== message.id
        || byEvent.conversationId !== message.conversationId
        || byEvent.sequence !== sequence)) {
        throw new Error("Immutable event identity conflict");
      }
      const existing = await messageRow(message.id);
      // Anti-resurrection: `mailbox_seen` and the message row are committed in one
      // transaction, so a recorded envelope with no stored row means the local
      // history was deliberately deleted (for example a conversation delete). A
      // replay may acknowledge identity, but must never restore content or the
      // conversation shell.
      if (mailbox && !existing) return { ...scope, mailboxId, eventId };
      await ensureConversationState(message.conversationId, conversationPeer(scope, message));
      // A legacy v3 tombstone is unbound. The stored row (if the message still
      // exists) or the authoritative envelope supplies the recipient, and the
      // binding commits with the suppression below.
      const priorTombstone = await tombstoneRow(message.id);
      const tombstone = priorTombstone
        ? await bindLegacyTombstone(priorTombstone, existing ? existing.recipientId : message.recipientId)
        : null;
      if (tombstone) assertTombstoneIdentity(tombstone, message);
      const deleted = (await driver.all<{ present: number }>(S.isDeletedForMe, [message.id])).length > 0;
      const cleared = (await driver.all<{ throughSequence: number }>(S.getClearThrough, [message.conversationId]))[0]?.throughSequence ?? 0;
      const suppressed = deleted || sequence <= cleared;

      if (existing) {
        if (!sameIdentity(existing, message)) throw new Error("Immutable message identity conflict");
        if (existing.eventId !== null && (existing.eventId !== eventId || existing.sequence !== sequence)) {
          throw new Error("Immutable message event conflict");
        }
        // Body is immutable unless an authoritative unsend already erased it.
        if (existing.body !== null && existing.body !== message.body) {
          throw new Error("Immutable message conflict");
        }
        if (existing.eventId === null) {
          // The participant-authorized echo confirms the pending message.
          await driver.run(S.setMessageServer, [eventId, sequence, message.id]);
        }
      } else {
        await ensureConversation(message.conversationId);
        if (tombstone) {
          await driver.run(S.insertTombstonedMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId,
            now(), tombstone.unsentAt,
          ]);
        } else if (suppressed) {
          await driver.run(S.insertTombstonedMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId, now(), null,
          ]);
        } else {
          await driver.run(S.insertMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId, message.body, now(),
          ]);
        }
        await driver.run(S.setMessageServer, [eventId, sequence, message.id]);
      }
      if (suppressed) await driver.run(S.erasePersonalMessage, [message.id]);

      // The stored identity owns the cursor, never a conflicting incoming tuple.
      await touch(message.conversationId, sequence);
      if (!existing || existing.eventId === null) {
        await driver.run(S.touchConversationState, [now(), message.conversationId]);
      }
      if (!mailbox) {
        await driver.run(S.insertMailboxEvent, [mailboxId, eventId, message.id, sequence, now()]);
      }
      // Only an echo of this account's own message confirms server success.
      if (message.authorId === scope.accountId) await driver.run(S.deleteOutbox, [message.id]);
      return { ...scope, mailboxId, eventId };
    });
  }

  async function persistInbound(envelope: MailboxEnvelope): Promise<PersistenceReceipt> {
    await assertOpen();
    return persist(envelope);
  }

  async function persistInboundAndAck(
    envelope: MailboxEnvelope,
    ack: (receipt: PersistenceReceipt) => Promise<void>,
  ): Promise<void> {
    const receipt = await serializedPersist(envelope);
    await assertOpen();
    await ack(receipt);
  }

  async function recordUnsend(tombstone: {
    messageId: string; conversationId: string; recipientId: string;
    unsentAt: number; unsentBy: string;
  }): Promise<void> {
    await assertOpen();
    const messageId = uuid(tombstone?.messageId);
    const conversationId = uuid(tombstone?.conversationId);
    const recipientId = uuid(tombstone?.recipientId);
    const unsentBy = uuid(tombstone?.unsentBy);
    if (recipientId === unsentBy) throw new Error("Unsend participant conflict");
    const unsentAt = positiveTimestamp(tombstone?.unsentAt);
    await transaction(async () => {
      const existing = await messageRow(messageId);
      if (existing) {
        if (existing.conversationId !== conversationId) throw new Error("Unsend conversation conflict");
        if (existing.authorId !== unsentBy) throw new Error("Unsend author conflict");
        if (existing.recipientId !== recipientId) throw new Error("Unsend recipient conflict");
      }
      const prior = await tombstoneRow(messageId);
      if (prior) {
        if (prior.conversationId !== conversationId || prior.unsentBy !== unsentBy
          || (prior.recipientId !== null && prior.recipientId !== recipientId)) {
          throw new Error("Unsend identity conflict");
        }
        if (prior.recipientId === null) {
          // Legacy v3 tombstone: bind the recipient now that it is known.
          await driver.run(S.bindTombstoneRecipient, [recipientId, messageId]);
        }
      } else {
        await driver.run(S.insertTombstone, [messageId, conversationId, recipientId, unsentAt, unsentBy]);
      }
      if (existing && existing.body !== null) {
        await driver.run(S.clearMessageBody, [unsentAt, messageId]);
      }
      // An unsent message must never be leased for delivery.
      await driver.run(S.deleteOutbox, [messageId]);
    });
  }

  async function deleteForMe(messageId: string): Promise<void> {
    await assertOpen();
    const id = uuid(messageId);
    await transaction(async () => {
      const existing = await messageRow(id);
      if (existing && existing.authorId !== scope.accountId && existing.recipientId !== scope.accountId) {
        throw new Error("Delete-for-me scope mismatch");
      }
      await driver.run(S.deleteForMe, [id, existing ? existing.conversationId : null, now()]);
      if (existing) {
        // Delete-for-me is local erasure: the plaintext must not stay readable in
        // the file. A message the server has never accepted is also cancelled so
        // it cannot be delivered after the user deleted it.
        await driver.run(S.erasePersonalMessage, [id]);
        if (existing.eventId === null && existing.authorId === scope.accountId) {
          await driver.run(S.deleteOutbox, [id]);
        }
      }
    });
  }

  async function clearThrough(conversationId: string, throughSequence: number): Promise<void> {
    await assertOpen();
    const id = uuid(conversationId);
    const through = positiveSequence(throughSequence);
    await transaction(async () => {
      await ensureConversation(id);
      await driver.run(S.insertClearConversation, [id, through, now()]);
      await driver.run(S.clearConversation, [through, now(), id]);
      // Clear-for-me is local erasure, exactly like delete-for-me and like the
      // server-metadata path in `applyStateChange`. Leaving the bodies in the
      // file would make "clear chat" a UI-only claim. Pending sends have no
      // server sequence, so they are never covered by the boundary.
      await driver.run(S.erasePersonalConversation, [id, through]);
    });
  }

  async function getStateCursor(): Promise<StateCursor | null> {
    await assertOpen();
    return (await driver.all<StateCursor>(S.getStateCursor))[0] ?? null;
  }

  async function applyStateChange(input: StateChangeEnvelope): Promise<StateCursor> {
    await assertOpen();
    const { change } = copyStateEnvelope(input, scope);
    const json = JSON.stringify(change);
    return transaction(async () => {
      const prior = (await driver.all<{ sequence: number; changeJson: string }>(S.getStateEvent, [change.eventId]))[0];
      if (prior) {
        if (prior.sequence !== change.sequence || prior.changeJson !== json) throw new Error("Immutable messaging state conflict");
        return { eventId: change.eventId, sequence: change.sequence };
      }
      await ensureConversationState(change.conversationId, statePeer(scope, change));
      if (change.kind === "CLEAR_FOR_ME") {
        await driver.run(S.insertClearConversation, [change.conversationId, change.throughSequence, change.occurredAt]);
        await driver.run(S.clearConversation, [change.throughSequence, change.occurredAt, change.conversationId]);
        await driver.run(S.erasePersonalConversation, [change.conversationId, change.throughSequence]);
      } else {
        const existing = await messageRow(change.messageId);
        if (existing && (existing.conversationId !== change.conversationId || existing.authorId !== change.authorId
          || existing.recipientId !== change.recipientId
          || (existing.sequence !== null && existing.sequence !== change.messageSequence))) {
          throw new Error("Messaging state message identity conflict");
        }
        if (change.kind === "UNSEND") {
          const tombstone = await tombstoneRow(change.messageId);
          if (tombstone && (tombstone.conversationId !== change.conversationId
            || tombstone.unsentBy !== change.authorId
            || (tombstone.recipientId !== null && tombstone.recipientId !== change.recipientId))) {
            throw new Error("Unsend identity conflict");
          }
          if (!tombstone) {
            await driver.run(S.insertTombstone, [change.messageId, change.conversationId, change.recipientId, change.occurredAt, change.authorId]);
          } else if (tombstone.recipientId === null) {
            await driver.run(S.bindTombstoneRecipient, [change.recipientId, change.messageId]);
          }
          if (!existing) await driver.run(S.insertTombstonedMessage, [change.messageId, change.conversationId,
            change.authorId, change.recipientId, now(), change.occurredAt]);
          else await driver.run(S.clearMessageBody, [change.occurredAt, change.messageId]);
        } else {
          await driver.run(S.deleteForMe, [change.messageId, change.conversationId, change.occurredAt]);
          if (!existing) await driver.run(S.insertTombstonedMessage, [change.messageId, change.conversationId,
            change.authorId, change.recipientId, now(), null]);
          await driver.run(S.erasePersonalMessage, [change.messageId]);
        }
        // A state change is metadata, not the message's TEXT event: it must not
        // stamp a server event identity. The authoritative echo owns that, and a
        // synthetic id here would make the real echo look like a conflict.
        await driver.run(S.deleteOutbox, [change.messageId]);
      }
      await driver.run(S.insertStateEvent, [change.eventId, change.sequence, json]);
      return { eventId: change.eventId, sequence: change.sequence };
    });
  }

  /**
   * Portable history: accepted messages only. A pending send is device-local
   * work, and mailbox receipts and read state are per-device, so none of them
   * may travel in a backup.
   */
  async function exportSnapshot(): Promise<HistorySnapshot> {
    await assertOpen();
    const conversations = await driver.all<{
      id: string; lastSequence: number; createdAt: number; updatedAt: number;
    }>(S.listSnapshotConversations);
    const messages = await driver.all<MessageRow & { createdAt: number }>(S.listSnapshotMessages);
    const tombstones = await driver.all<TombstoneRow>(S.listSnapshotTombstones);
    const deletedForMe = await driver.all<{
      messageId: string; conversationId: string | null; deletedAt: number;
    }>(S.listSnapshotDeletedForMe);
    const clears = await driver.all<{
      conversationId: string; throughSequence: number; clearedAt: number;
    }>(S.listSnapshotClears);
    return {
      conversations: conversations.map((row) => ({
        id: row.id, lastSequence: row.lastSequence,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      })),
      messages: messages.map((row) => ({
        id: row.id, conversationId: row.conversationId, authorId: row.authorId,
        recipientId: row.recipientId, body: row.body,
        // The query filters on both, so these are never null here.
        serverEventId: row.eventId as string, serverSequence: row.sequence as number,
        unsentAt: row.unsentAt, createdAt: row.createdAt,
      })),
      tombstones: tombstones.map((row) => ({
        messageId: row.messageId, conversationId: row.conversationId,
        recipientId: row.recipientId, unsentAt: row.unsentAt, unsentBy: row.unsentBy,
      })),
      deletedForMe: deletedForMe.map((row) => ({ ...row })),
      clears: clears.map((row) => ({ ...row })),
    };
  }

  /**
   * Merge a snapshot in one transaction.
   *
   * Contradictions fail closed rather than picking a side, because a silently
   * chosen body or author is unrecoverable. Suppression is the one asymmetric
   * rule and it is deliberate: `null` always wins, so no import path can bring
   * back a body the user erased.
   *
   * The merge creates no outbox row, no mailbox receipt and no state event: a
   * restore is not a send, not an acknowledgement and not metadata application.
   */
  async function importSnapshot(snapshot: HistorySnapshot): Promise<ImportReport> {
    await assertOpen();
    // This is a public entry point: the caller may not have gone through
    // decodeBackup, so the records are validated again against this database's
    // own account rather than trusting the caller. `normaliseSnapshot` performs
    // the single guarded read of the caller's object and returns plain records,
    // so nothing below this line re-reads caller-owned data.
    const incoming = normaliseSnapshot(snapshot);
    validateSnapshot(incoming, scope.accountId);
    return transaction(async () => {
      const report: ImportReport = {
        conversations: 0, messages: 0, tombstones: 0, deletedForMe: 0, clears: 0,
      };

      // Tombstones are merged before messages, so the contradiction check needs
      // to see both what this device already has and what the snapshot claims.
      const incomingMessages = new Map(incoming.messages.map((message) => [message.id, message]));

      for (const conversation of incoming.conversations) {
        await driver.run(S.insertConversation, [conversation.id, conversation.createdAt, conversation.updatedAt]);
        await driver.run(S.mergeConversation, [
          conversation.lastSequence, conversation.updatedAt, conversation.createdAt, conversation.id,
        ]);
        report.conversations += 1;
      }

      for (const tombstone of incoming.tombstones) {
        const claimed = incomingMessages.get(tombstone.messageId);
        if (claimed) assertSnapshotTombstone(tombstone, claimed);
        const localMessage = (await driver.all<MessageRow>(
          S.getSnapshotMessage, [tombstone.messageId],
        ))[0];
        if (localMessage) {
          assertSnapshotTombstone(tombstone, localMessage);
          // Adopt the tombstone's time here as well as in the message loop, so the
          // result does not depend on which of the two arrived first.
          if (localMessage.unsentAt === null) {
            await driver.run(S.setMessageUnsentAt, [tombstone.unsentAt, tombstone.messageId]);
          }
        }
        // The same legacy binding rule as the inbound path: an unbound tombstone
        // takes the recipient the message actually has. Never mutate the caller's
        // snapshot to do it.
        const recipientId = tombstone.recipientId ?? localMessage?.recipientId ?? claimed?.recipientId ?? null;
        const existing = await tombstoneRow(tombstone.messageId);
        if (existing) {
          if (existing.conversationId !== tombstone.conversationId
            || existing.unsentBy !== tombstone.unsentBy
            || existing.unsentAt !== tombstone.unsentAt
            || (existing.recipientId !== null && recipientId !== null
              && existing.recipientId !== recipientId)) {
            throw new BackupError("backup: identity conflict");
          }
          if (existing.recipientId === null && recipientId !== null) {
            await driver.run(S.bindTombstoneRecipient, [recipientId, tombstone.messageId]);
          }
        } else {
          await driver.run(S.insertTombstone, [tombstone.messageId, tombstone.conversationId,
            recipientId, tombstone.unsentAt, tombstone.unsentBy]);
        }
        report.tombstones += 1;
      }

      for (const deletion of incoming.deletedForMe) {
        // `coalesce` is only direction-independent when one side is unknown, so a
        // disagreement between two known conversations is a contradiction rather
        // than something to merge.
        const existingDeletion = await driver.all<{ conversationId: string | null }>(
          S.getDeletedForMe, [deletion.messageId],
        );
        if (existingDeletion.length > 0 && existingDeletion[0]!.conversationId !== null
          && deletion.conversationId !== null
          && existingDeletion[0]!.conversationId !== deletion.conversationId) {
          throw new BackupError("backup: identity conflict");
        }
        await driver.run(S.deleteForMe, [deletion.messageId, deletion.conversationId, deletion.deletedAt]);
        await driver.run(S.mergeDeletedForMe, [deletion.conversationId, deletion.deletedAt, deletion.messageId]);
        report.deletedForMe += 1;
      }

      for (const clear of incoming.clears) {
        await ensureConversation(clear.conversationId);
        await driver.run(S.insertClearConversation, [clear.conversationId, clear.throughSequence, clear.clearedAt]);
        await driver.run(S.mergeClear, [clear.throughSequence, clear.clearedAt, clear.conversationId]);
        report.clears += 1;
      }

      for (const message of incoming.messages) {
        const localTombstone = await tombstoneRow(message.id);
        if (localTombstone) {
          assertSnapshotTombstone(localTombstone, message);
          if (localTombstone.recipientId === null) {
            await bindLegacyTombstone(localTombstone, message.recipientId);
          }
        }
        // A tombstone is the authority on when the unsend happened, so a message
        // that never carried the time adopts it rather than leaving the two rows
        // describing different events.
        const unsentAt = message.unsentAt ?? localTombstone?.unsentAt ?? null;
        const existing = (await driver.all<MessageRow & { createdAt: number }>(
          S.getSnapshotMessage, [message.id],
        ))[0];
        const createdAt = message.createdAt ?? 0;
        if (existing) {
          if (existing.conversationId !== message.conversationId
            || existing.authorId !== message.authorId
            || existing.recipientId !== message.recipientId
            || (existing.eventId !== null && existing.eventId !== message.serverEventId)
            || (existing.sequence !== null && existing.sequence !== message.serverSequence)
            || (existing.body !== null && message.body !== null && existing.body !== message.body)
            || (existing.unsentAt !== null && message.unsentAt !== null
              && existing.unsentAt !== message.unsentAt)) {
            throw new BackupError("backup: identity conflict");
          }
          const body = existing.body === null || message.body === null ? null : existing.body;
          const mergedUnsentAt = existing.unsentAt ?? unsentAt;
          // 0 means "never observed", so a known value always beats it.
          const merged = existing.createdAt === 0 ? createdAt
            : createdAt === 0 ? existing.createdAt : Math.min(existing.createdAt, createdAt);
          await driver.run(S.updateSnapshotMessage, [body, mergedUnsentAt, merged, message.id]);
          if (existing.eventId === null) {
            // The message was accepted but this device never saw the echo. Adopt
            // the authoritative identity and drop the pending send so a restore
            // cannot re-send a message that already exists on the server.
            await driver.run(S.setMessageServer, [message.serverEventId, message.serverSequence, message.id]);
            await driver.run(S.deleteOutbox, [message.id]);
          }
        } else {
          // Convert what would otherwise be a raw SQLite constraint error into
          // the documented code: a different message already occupies this
          // conversation sequence, or another message already owns this event.
          const atSequence = await driver.all<{ id: string }>(
            S.getMessageAtSequence, [message.conversationId, message.serverSequence],
          );
          if (atSequence.length > 0) throw new BackupError("backup: identity conflict");
          const byEvent = await driver.all<MessageRow>(S.getMessageByEvent, [message.serverEventId]);
          if (byEvent.length > 0 && byEvent[0]!.id !== message.id) {
            throw new BackupError("backup: identity conflict");
          }
          await ensureConversation(message.conversationId);
          await driver.run(S.insertSnapshotMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId,
            message.body, createdAt, message.serverEventId, message.serverSequence, unsentAt,
          ]);
        }
        report.messages += 1;
      }

      // Backstop, inside the same transaction: whatever the snapshot claimed,
      // nothing may end up visible behind a tombstone, a personal deletion or a
      // clear. This is what makes a stale backup safe to restore.
      await driver.run(S.suppressTombstonedBodies);
      await driver.run(S.suppressDeletedBodies);
      await driver.run(S.suppressUnsentBodies);
      await driver.run(S.suppressClearedBodies);
      return report;
    });
  }

  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  function serial<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      // Snapshot BEFORE joining the queue; callers cannot mutate a delayed write.
      const captured = structuredClone(args);
      const next = tail.then(async () => {
        if (closed) throw new Error("Messaging history closed");
        const result = await work(...captured);
        if (closed) throw new Error("Messaging history closed");
        return result;
      });
      tail = next.catch(() => undefined);
      return next;
    };
  }
  const serializedPersist = serial(persistInbound);
  const serializedImport = serial(importSnapshot);

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    // Invalidate immediately; finish/rollback a dispatched transaction before
    // closing its native handle. No queued operation or ACK survives close.
    closing = tail.then(() => driver.close());
    return closing;
  }

  return {
    enqueueOutgoing: serial(enqueueOutgoing), getMessage: serial(getMessage),
    listMessages: serial(listMessages), listOutbox: serial(listOutbox),
    listConversations: serial(listConversations), cacheConversation: serial(cacheConversation),
    markConversationRead: serial(markConversationRead),
    getStateCursor: serial(getStateCursor), applyStateChange: serial(applyStateChange),
    claimNextOutgoing: serial(claimNextOutgoing), failOutgoing: serial(failOutgoing),
    persistInbound: serializedPersist, persistInboundAndAck, close,
    recordUnsend: serial(recordUnsend), deleteForMe: serial(deleteForMe), clearThrough: serial(clearThrough),
    exportSnapshot: serial(exportSnapshot),
    // The guarded read must happen *before* the serial queue clones its
    // arguments: `structuredClone` invokes accessors, so a hostile snapshot
    // would otherwise throw a raw Error outside the documented `BackupError`
    // boundary. `normaliseSnapshot` reads once and returns plain records, which
    // is exactly what the queue is allowed to clone.
    // `async` matters: a synchronous throw here would escape the promise
    // contract every other method keeps, so callers would need a try/catch.
    importSnapshot: async (snapshot: HistorySnapshot) =>
      serializedImport(normaliseSnapshot(snapshot)),
  };
}
