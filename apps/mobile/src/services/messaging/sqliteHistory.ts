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
  HistorySnapshot, HumanMessage, ImportReport, MailboxEnvelope, MediaAttachment, MediaBytesPort,
  MessagingHistory, MessagingScope, OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage,
} from "./history";
import { MediaParentUnavailableError } from "./history";
import { BackupError, normaliseSnapshot, validateSnapshot } from "./backup";
import {
  MESSAGES_V5_BODY_CHECK,
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
import { cachedMediaAllowed, copyMessage, copyMediaAttachment, copyMediaMessage, positiveSequence, uuid } from "./validation";
import {
  isMediaSha256, sameMediaIdentity, verifyMediaBytes, type MediaMetadata, type MediaUploadAttempt,
} from "./media";
import { verifyMediaContent, type MediaDecoder } from "./mediaContent";
import { withHistoryLock } from "./historyLock";

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
  /**
   * The chat-media byte store. Required for every media operation and never for
   * text: the two durable stores stay independent, ordered rather than shared.
   */
  mediaBytes?: MediaBytesPort;
  decodeMedia?: MediaDecoder;
  /** Production registry admission runs under the existing account Web Lock. */
  accountAdmission?: () => Promise<void>;
  cleanupOnly?: boolean;
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

/** `media_attachments` as the adapter reads it; validation re-checks every field. */
interface MediaRow {
  id: string;
  messageId: string;
  direction: "OUT" | "IN";
  sha256: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  expiresAt: number | null;
  lastAccessAt: number;
  state: string;
  attempts: number;
  token: string | null;
  leaseUntil: number | null;
}

const LEASE_MS = 60_000;

/**
 * Every schema this build can migrate forward from. A version outside this list
 * is a file written by a newer build, and it is refused before any mutation.
 */
const SUPPORTED_PRIOR_VERSIONS: readonly string[] = [
  "1", "2", "3", "4", "5", String(MESSAGING_SQLITE_SCHEMA_VERSION),
];

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
    if (storedVersion !== null && !SUPPORTED_PRIOR_VERSIONS.includes(storedVersion)) {
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

  // v6 DDL belongs to the identity/version transaction below, never a partially
  // applied upgrade outside that lock. Prior migrations retain their ordering.
  for (const statement of MESSAGING_SQLITE_SCHEMA) {
    if (!statement.includes("media_attachments")) await driver.exec(statement);
  }

  // v4 -> v5: `messages.body` must admit the empty string so an image-only
  // message has somewhere to live. A CHECK constraint cannot be altered in
  // place, so this is SQLite's documented table rebuild: new table, exact copy,
  // prove the copy, drop, rename, recreate the indexes. Foreign keys are turned
  // off for the drop (other tables reference `messages`) and integrity is proven
  // with `foreign_key_check` before the commit, which is why the pragma is
  // restored in `finally` rather than trusted to survive an abort.
  const messagesTable = (await driver.all<{ sql: string }>(S.messagesTableSql))[0];
  // Fail-safe direction: rebuild unless the table already carries the v5 CHECK.
  // Matching the OLD text positively would skip the migration on any future
  // build whose DDL formatting differs, leaving a v5-stamped file that rejects
  // `''`. Rebuilding an already-correct table is harmless — the copy is proven
  // exact and nothing is dropped until it is.
  if (messagesTable && !messagesTable.sql.includes(MESSAGES_V5_BODY_CHECK)) {
    await driver.exec("pragma foreign_keys = off");
    const disabled = (await driver.all<{ foreign_keys: number }>(D.foreignKeys))[0]?.foreign_keys;
    if (disabled !== 0) throw new Error("Messaging storage could not disable foreign keys for the v5 rebuild");
    try {
      await driver.exec("begin immediate");
      try {
        await driver.exec(S.createMessagesV5);
        await driver.run(S.copyMessagesV5);
        // Exact set comparison in both directions: a count alone would accept a
        // copy that dropped one row and duplicated another.
        const missing = (await driver.all<{ n: number }>(S.missingMessagesV5))[0]?.n;
        const extra = (await driver.all<{ n: number }>(S.extraMessagesV5))[0]?.n;
        if (missing !== 0 || extra !== 0) {
          throw new Error("Messaging v5 rebuild did not preserve every message");
        }
        await driver.exec(S.dropMessages);
        await driver.exec(S.renameMessagesV5);
        await driver.exec(S.recreateMessagesEventIndex);
        await driver.exec(S.recreateMessagesConversationIndex);
        if ((await driver.all(S.foreignKeyCheck)).length > 0) {
          throw new Error("Messaging v5 rebuild broke referential integrity");
        }
        await driver.exec("commit");
      } catch (error) {
        try { await driver.exec("rollback"); } catch { /* commit may already have failed */ }
        throw error;
      }
    } finally {
      await driver.exec("pragma foreign_keys = on");
    }
    const restored = (await driver.all<{ foreign_keys: number }>(D.foreignKeys))[0]?.foreign_keys;
    if (restored !== 1) throw new Error("Messaging storage requires foreign_keys = ON");
  }

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
    if (storedVersion !== null && !SUPPORTED_PRIOR_VERSIONS.includes(storedVersion)) {
      throw new Error("Unsupported messaging schema version");
    }
    if (storedAccount !== null && storedAccount !== scope.accountId) {
      throw new Error("Messaging database belongs to a different account");
    }
    if (storedDevice !== null && storedDevice !== scope.deviceId) {
      throw new Error("Messaging database belongs to a different installation");
    }
    for (const statement of MESSAGING_SQLITE_SCHEMA) {
      if (statement.includes("media_attachments")) await driver.exec(statement);
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

  async function historyIsPurged() {
    return (await driver.all(S.getMeta, ["history_purged"])).length > 0;
  }

  async function assertOpen(allowPurged = false) {
    if (closed) throw new Error("Messaging history closed");
    const binding = new Map(
      (await driver.all<{ key: string; value: string }>(S.getMetaRows)).map((row) => [row.key, row.value]),
    );
    if (closed) throw new Error("Messaging history closed");
    if (binding.get("account_id") !== scope.accountId || binding.get("device_id") !== scope.deviceId) {
      throw new Error("Messaging database binding conflict");
    }
    if (!allowPurged && await historyIsPurged()) throw new Error("Messaging history purged");
    if (closed) throw new Error("Messaging history closed");
  }

  async function transaction<T>(work: () => Promise<T>,
    onOutcome?: (outcome: "committed" | "rolled-back" | "unknown") => void, allowPurged = false): Promise<T> {
    let committed = false;
    try {
      // A rejected bridge reply does not prove BEGIN failed to execute. Include
      // acquisition in rollback/invalidation so it cannot leak a writer lock.
      await driver.exec("begin immediate");
      await assertOpen(allowPurged);
      const result = await work();
      // Text suppression and attachment suppression share the metadata commit.
      // Bytes go afterwards: failed cleanup leaves garbage, never a live lie.
      const suppressed = await driver.all<{ id: string }>(S.suppressedMedia);
      for (const row of suppressed) await driver.run(S.deleteMediaAttachment, [row.id]);
      if (closed) throw new Error("Messaging history closed");
      await driver.exec("commit");
      committed = true;
      onOutcome?.("committed");
      if (suppressed.length && options.mediaBytes) {
        await options.mediaBytes.delete(scope.accountId, suppressed.map((row) => row.id)).catch(() => undefined);
      }
      if (closed) throw new Error("Messaging history closed");
      return result;
    } catch (error) {
      if (!committed) {
        let outcome: "rolled-back" | "unknown" = "unknown";
        try { await driver.exec("rollback"); outcome = "rolled-back"; }
        catch { /* BEGIN/COMMIT may have executed despite a lost bridge reply. */ }
        onOutcome?.(outcome);
        if (outcome === "unknown") {
          // The transaction may still be active. Never expose its uncommitted
          // rows through later reads or leave the writer lane reusable. Close
          // directly here, NOT via close()'s tail (which contains this call).
          closed = true;
          lockLifetime.abort(new Error("Messaging history transaction outcome unknown"));
          await closeDriver().catch(() => undefined); // preserve the original operation error
        }
      }
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
    const message = copyMediaMessage(attempt?.message);
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
    // The server keeps the TEXT envelope for captionless MEDIA messages.
    const message = copyMediaMessage(envelope.event.message);
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
    const { completion } = await serial(async () => {
      // As for media: validate under the account lock and dispatch without an
      // await gap. Async ACK completion must not hold the queue or lock.
      if (closed) throw new Error("Messaging history closed");
      const completion = Promise.resolve(ack(receipt));
      void completion.catch(() => undefined);
      return { completion };
    })();
    await completion;
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

  let mediaPurged = false;
  function byteStore(): MediaBytesPort {
    if (!options.mediaBytes) throw new Error("Messaging media byte storage unavailable");
    return options.mediaBytes;
  }

  async function mediaRow(id: string): Promise<MediaAttachment | null> {
    const row = (await driver.all<MediaRow>(S.getMediaAttachment, [id]))[0];
    return row ? copyMediaAttachment(row) : null;
  }

  async function mediaParent(metadata: MediaMetadata): Promise<MessageRow> {
    const row = await messageRow(metadata.messageId);
    const visible = (await driver.all(S.getMediaParent, [metadata.messageId])).length > 0;
    if (!row || !visible) throw new MediaParentUnavailableError(metadata.messageId);
    if (row.authorId !== scope.accountId && row.recipientId !== scope.accountId) {
      throw new Error("Media participant scope mismatch");
    }
    if (metadata.direction !== (row.authorId === scope.accountId ? "OUT" : "IN")) {
      throw new Error("Media direction scope mismatch");
    }
    return row;
  }

  async function mediaReplay(metadata: MediaMetadata): Promise<MediaAttachment | null> {
    const existing = await mediaRow(metadata.id);
    const byMessage = (await driver.all<MediaRow>(S.getMediaByMessage, [metadata.messageId]))[0];
    if ((existing && !sameMediaIdentity(existing, metadata))
      || (byMessage && byMessage.id !== metadata.id)) throw new Error("Media identity conflict");
    return existing;
  }

  async function insertMedia(record: MediaAttachment): Promise<void> {
    const row = copyMediaAttachment(record);
    await driver.run(S.insertMediaAttachment, [row.id, row.messageId, row.direction, row.sha256,
      row.mime, row.byteSize, row.width, row.height, row.expiresAt, row.lastAccessAt,
      row.state, row.attempts, row.token ?? null, row.leaseUntil ?? null]);
  }

  /** Compensate a new byte entry only after a positively acknowledged rollback. */
  async function withMediaBytes<T>(metadata: MediaMetadata, bytes: ArrayBuffer,
    work: (store: MediaBytesPort) => Promise<T>): Promise<T> {
    const store = byteStore();
    let newlyWritten = false;
    let rolledBack = false;
    try {
      return await transaction(async () => {
        if ((await driver.all<{ value: string }>(S.getMeta, ["media_purged"]))[0]?.value === "1") {
          throw new Error("Messaging media purged");
        }
        // Guard immutable identities before overwriting any byte entry.
        await mediaReplay(metadata);
        const prior = await store.get(scope.accountId, metadata.id);
        if (prior) await verifyMediaBytes(metadata, prior);
        else {
          await store.put(scope.accountId, metadata.id, bytes);
          newlyWritten = true;
        }
        return work(store);
      }, (outcome) => { rolledBack = outcome === "rolled-back"; });
    } catch (error) {
      // A rejected COMMIT response does not prove it failed. Unknown outcomes
      // retain bytes: sweepable garbage is safer than destroying a live row.
      if (newlyWritten && rolledBack) {
        await store.delete(scope.accountId, [metadata.id]).catch(() => undefined);
      }
      throw error;
    }
  }

  async function canSendMedia(conversationId: string): Promise<boolean> {
    const state = (await driver.all<StateRow>(S.getConversationState, [conversationId]))[0];
    return cachedMediaAllowed(state ? localState(state).projection : undefined);
  }

  async function enqueueOutgoingWithMedia(message: HumanMessage, input: MediaMetadata, bytes: ArrayBuffer): Promise<void> {
    await assertOpen();
    const outgoing = copyMediaMessage(message);
    const record = copyMediaAttachment({ ...input, state: "QUEUED", attempts: 0, lastAccessAt: now() });
    if (outgoing.authorId !== scope.accountId || record.direction !== "OUT" || record.messageId !== outgoing.id) {
      throw new Error("Outgoing media scope mismatch");
    }
    if (!await canSendMedia(outgoing.conversationId)) throw new Error("Media unavailable");
    byteStore();
    await verifyMediaContent(record, bytes, options.decodeMedia);
    await withMediaBytes(record, bytes, async () => {
      await ensureConversationState(outgoing.conversationId, conversationPeer(scope, outgoing));
      if (await tombstoneRow(outgoing.id) || (await driver.all(S.isDeletedForMe, [outgoing.id])).length) {
        throw new MediaParentUnavailableError(outgoing.id);
      }
      const parent = await messageRow(outgoing.id);
      if (parent) {
        if (!sameIdentity(parent, outgoing) || parent.body !== outgoing.body) throw new Error("Immutable message identity conflict");
      } else {
        await driver.run(S.insertMessage, [outgoing.id, outgoing.conversationId, outgoing.authorId,
          outgoing.recipientId, outgoing.body, now()]);
        await driver.run(S.enqueueOutbox, [outgoing.id]);
        await driver.run(S.touchConversationState, [now(), outgoing.conversationId]);
      }
      await mediaParent(record);
      if (!await mediaReplay(record)) await insertMedia(record);
    });
  }

  async function claimNextMediaUpload(): Promise<MediaUploadAttempt | null> {
    await assertOpen();
    const store = byteStore();
    return transaction(async () => {
      const time = positiveTimestamp(now());
      const candidates = await driver.all<{ id: string; conversationId: string }>(S.nextMediaUpload, [time]);
      let candidate: { id: string } | undefined;
      for (const row of candidates) {
        if (await canSendMedia(row.conversationId)) { candidate = row; break; }
      }
      if (!candidate) return null;
      const row = (await mediaRow(candidate.id))!;
      await mediaParent(row);
      const bytes = await store.get(scope.accountId, row.id);
      if (!bytes) throw new Error("Media bytes missing");
      await verifyMediaBytes(row, bytes);
      const token = uuid(tokenFactory());
      const claimed = copyMediaAttachment({ ...row, state: "UPLOADING", token,
        leaseUntil: time + leaseMs, attempts: row.attempts + 1 });
      await driver.run(S.claimMediaUpload, [token, claimed.leaseUntil!, row.id]);
      return { attachmentId: row.id, messageId: row.messageId, sha256: row.sha256,
        token, attempt: claimed.attempts };
    });
  }

  async function settleMediaUpload(input: MediaUploadAttempt, success: boolean): Promise<boolean> {
    await assertOpen(); byteStore();
    const id = uuid(input?.attachmentId);
    const messageId = uuid(input?.messageId);
    const token = uuid(input?.token);
    const attempt = positiveSequence(input?.attempt);
    if (!isMediaSha256(input?.sha256)) throw new Error("Invalid media digest");
    return transaction(async () => {
      const row = await mediaRow(id);
      if (!row) return false;
      if (row.messageId !== messageId || row.sha256 !== input.sha256) throw new Error("Media attempt identity conflict");
      await mediaParent(row);
      return (await driver.run(success ? S.completeMediaUpload : S.failMediaUpload, [id, token, attempt])) === 1;
    });
  }

  async function persistVerifiedMedia(input: MediaMetadata, bytes: ArrayBuffer): Promise<MediaAttachment> {
    await assertOpen(); byteStore();
    const record = copyMediaAttachment({ ...input, state: "AWAITING_ACK", attempts: 0, lastAccessAt: now() });
    await mediaParent(record); // Defer before writing bytes for a missing parent.
    await mediaReplay(record);
    await verifyMediaContent(record, bytes, options.decodeMedia);
    return withMediaBytes(record, bytes, async () => {
      await mediaParent(record); // Re-check under the write lock after decoding.
      const existing = await mediaReplay(record);
      if (existing) await driver.run(S.setMediaAwaitingAck, [record.expiresAt, now(), record.id]);
      else await insertMedia(record);
      return (await mediaRow(record.id))!;
    });
  }

  async function markMediaReady(attachmentId: string): Promise<boolean> {
    await assertOpen();
    const store = byteStore();
    return transaction(async () => {
      const row = await mediaRow(uuid(attachmentId));
      if (!row || row.state !== "AWAITING_ACK") return false;
      await mediaParent(row);
      const bytes = await store.get(scope.accountId, row.id);
      if (!bytes) throw new Error("Media bytes missing");
      await verifyMediaBytes(row, bytes);
      return (await driver.run(S.markMediaReady, [row.id])) === 1;
    });
  }

  async function listMedia(conversationId: string): Promise<MediaAttachment[]> {
    await assertOpen();
    return (await driver.all<MediaRow>(S.listMediaForConversation, [uuid(conversationId)])).map(copyMediaAttachment);
  }

  async function readMedia(attachmentId: string): Promise<ArrayBuffer | null> {
    await assertOpen();
    const store = byteStore();
    return transaction(async () => {
      const row = await mediaRow(uuid(attachmentId));
      if (!row || row.state === "EVICTED") return null;
      if (!(await driver.all(S.getMediaParent, [row.messageId])).length) return null;
      await mediaParent(row);
      const bytes = await store.get(scope.accountId, row.id);
      if (!bytes) return null;
      await verifyMediaBytes(row, bytes);
      await driver.run(S.touchMediaAccess, [now(), row.id]);
      return bytes;
    });
  }

  function sweepLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid media sweep limit");
    return limit;
  }

  async function evictMedia(limit: number): Promise<number> {
    await assertOpen();
    const store = byteStore();
    const ids = await transaction(async () => {
      const candidates = await driver.all<{ id: string }>(S.evictableMedia, [sweepLimit(limit)]);
      for (const row of candidates) await driver.run(S.markMediaEvicted, [row.id]);
      return candidates.map((row) => row.id);
    });
    // A failed delete leaves EVICTED + orphan bytes; no live reader can use them.
    await store.delete(scope.accountId, ids);
    return ids.length;
  }

  async function sweepOrphanMedia(limit: number): Promise<number> {
    await assertOpen();
    const store = byteStore();
    const keep = new Set((await driver.all<{ id: string }>(S.listLiveMediaIds)).map((row) => row.id));
    return store.sweep(scope.accountId, keep, sweepLimit(limit));
  }

  async function removeMediaForMessage(messageId: string): Promise<void> {
    // Removal is a real personal deletion, not a way to erase metadata while
    // allowing a late callback to silently recreate it.
    byteStore();
    await deleteForMe(uuid(messageId));
  }

  async function clearMedia(): Promise<void> {
    await assertOpen();
    const store = byteStore();
    await transaction(async () => {
      await driver.run(S.setMetaIfAbsent, ["media_purged", "1"]);
      await driver.run(S.deleteAllMedia);
    });
    mediaPurged = true;
    await store.clearAccount(scope.accountId);
  }

  async function purgeHistory(): Promise<void> {
    const store = byteStore();
    await transaction(async () => {
      await driver.run(S.setMetaIfAbsent, ["history_purged", "1"]);
      await driver.run(S.setMetaIfAbsent, ["media_purged", "1"]);
      for (const statement of S.purgeHistory) await driver.run(statement);
      if ((await driver.all<{ n: number }>(S.historyRowCount))[0]?.n !== 0) {
        throw new Error("Messaging history purge incomplete");
      }
    }, undefined, true);
    mediaPurged = true;
    // Never compensate byte deletion on ambiguous metadata outcomes. A lost
    // COMMIT response leaves the durable fence for an explicit reopened retry.
    await store.clearAccount(scope.accountId);
    if ((await store.keys(scope.accountId)).length) {
      throw new Error("Messaging history bytes remain");
    }
  }

  const lockLifetime = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;
  let driverClosing: Promise<void> | null = null;
  function closeDriver(): Promise<void> {
    // Shared by owner close and unknown-outcome invalidation, even when the
    // owner has already queued a close behind the current transaction.
    return driverClosing ??= Promise.resolve().then(() => driver.close());
  }
  function serial<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>, allowPurged = false) {
    return async (...args: Args): Promise<Result> => {
      // Snapshot BEFORE joining the queue; callers cannot mutate a delayed write.
      const captured = structuredClone(args);
      const next = tail.then(async () => {
        if (closed) throw new Error("Messaging history closed");
        const result = await withHistoryLock(scope.accountId, lockLifetime.signal, allowPurged || !!options.mediaBytes || !!options.accountAdmission,
          async () => {
            if (!allowPurged && options.cleanupOnly) throw new Error("Messaging deletion cleanup only");
            if (!allowPurged) await options.accountAdmission?.();
            await assertOpen(allowPurged); return work(...captured);
          });
        if (closed) throw new Error("Messaging history closed");
        return result;
      });
      tail = next.catch(() => undefined);
      return next;
    };
  }
  const serializedPersist = serial(persistInbound);
  const serializedImport = serial(importSnapshot);
  const serializedMediaPersist = serial(persistVerifiedMedia);
  const serializedMediaReady = serial(markMediaReady);

  async function persistVerifiedMediaAndAck(metadata: MediaMetadata, bytes: ArrayBuffer,
    ack: (attachment: MediaAttachment) => Promise<void>): Promise<void> {
    if (typeof ack !== "function") throw new Error("Invalid media ACK callback");
    const record = await serializedMediaPersist(metadata, bytes);
    const { completion } = await serial(async () => {
      if ((await driver.all<{ value: string }>(S.getMeta, ["media_purged"]))[0]?.value === "1") {
        throw new Error("Messaging media purged");
      }
      const current = await mediaReplay(record);
      if (!current || (current.state !== "AWAITING_ACK" && current.state !== "READY")) {
        throw new Error("Media unavailable");
      }
      await mediaParent(current);
      const stored = await byteStore().get(scope.accountId, current.id);
      if (!stored) throw new Error("Media bytes missing");
      await verifyMediaBytes(current, stored);
      // Callback ENTRY is the admission point, while still holding the account
      // lock. No await between this invalidation check and dispatch. Return a
      // box, not the promise itself: reentrant async completion must not hold
      // the lock or block the local queue it may need.
      if (closed) throw new Error("Messaging history closed");
      const completion = Promise.resolve(ack(structuredClone(current)));
      void completion.catch(() => undefined);
      return { completion };
    })();
    await completion;
    if (!closed && !mediaPurged) await serializedMediaReady(record.id);
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    lockLifetime.abort(new Error("Messaging history closed"));
    // Invalidate immediately; finish/rollback a dispatched transaction before
    // closing its native handle. No new ACK entry survives close; an already
    // entered remote callback completes outside this drained storage queue.
    closing = tail.then(closeDriver);
    return closing;
  }

  if (options.mediaBytes && !options.cleanupOnly) {
    try { await serial(async () => { if (!await historyIsPurged()) await sweepOrphanMedia(100); }, true)(); }
    catch (error) { await close(); throw error; }
  }

  return {
    enqueueOutgoingWithMedia: serial(enqueueOutgoingWithMedia),
    claimNextMediaUpload: serial(claimNextMediaUpload),
    failMediaUpload: serial((attempt: MediaUploadAttempt) => settleMediaUpload(attempt, false)),
    completeMediaUpload: serial((attempt: MediaUploadAttempt) => settleMediaUpload(attempt, true)),
    persistVerifiedMediaAndAck, markMediaReady: serializedMediaReady,
    listMedia: serial(listMedia), readMedia: serial(readMedia), evictMedia: serial(evictMedia),
    sweepOrphanMedia: serial(sweepOrphanMedia), removeMediaForMessage: serial(removeMediaForMessage),
    clearMedia: serial(clearMedia), purgeHistory: serial(purgeHistory, true),
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
