/**
 * Android-side local history adapter over an injected SQLite driver (R3 §7–§10).
 *
 * The driver is injected so this module never imports a Node-only or native
 * binding; the Capacitor SQLite bridge is a thin driver later. Tests execute the
 * real statements against a real SQLite engine, which proves the schema and SQL —
 * not Android device behaviour, the bridge, or power-loss durability.
 *
 * Driver precondition: a durable, file-backed connection. `open()` rejects an
 * in-memory database or any connection where WAL/FULL/foreign-keys did not take
 * effect, because a persistence receipt is only honest after a durable commit.
 */
import type {
  HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope,
  OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage,
} from "./history";
import {
  MESSAGING_SQLITE_DURABILITY_CHECKS as D,
  MESSAGING_SQLITE_PRAGMAS,
  MESSAGING_SQLITE_SCHEMA,
  MESSAGING_SQLITE_SCHEMA_VERSION,
  MESSAGING_SQLITE_STATEMENTS as S,
} from "./sqliteSchema";
import { copyMessage, positiveSequence, uuid } from "./validation";

export type SqliteValue = string | number | null;

export interface SqliteDriver {
  exec(sql: string): void;
  all<T = Record<string, SqliteValue>>(sql: string, params?: readonly SqliteValue[]): T[];
  /** Returns the number of changed rows. */
  run(sql: string, params?: readonly SqliteValue[]): number;
  close(): void;
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

export function openSqliteMessagingHistory(
  driver: SqliteDriver,
  identity: MessagingScope,
  options: SqliteHistoryOptions = {},
): MessagingHistory & {
  recordUnsend(tombstone: { messageId: string; conversationId: string; unsentAt: number; unsentBy: string }): Promise<void>;
  deleteForMe(messageId: string): Promise<void>;
  clearThrough(conversationId: string, throughSequence: number): Promise<void>;
} {
  const scope: MessagingScope = { accountId: uuid(identity?.accountId), deviceId: uuid(identity?.deviceId) };
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  if (typeof leaseMs !== "number" || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    driver.close();
    throw new Error("Invalid messaging lease duration");
  }
  const tokenFactory = options.token ?? defaultToken;
  let closed = false;

  for (const pragma of MESSAGING_SQLITE_PRAGMAS) driver.exec(pragma);
  if (options.busyTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
      driver.close();
      throw new Error("Invalid messaging busy timeout");
    }
    driver.exec(`pragma busy_timeout = ${options.busyTimeoutMs}`);
  }

  // Verify durability instead of assuming the pragmas applied.
  const journalMode = driver.all<{ journal_mode: string }>(D.journalMode)[0]?.journal_mode;
  const synchronous = driver.all<{ synchronous: number }>(D.synchronous)[0]?.synchronous;
  const foreignKeys = driver.all<{ foreign_keys: number }>(D.foreignKeys)[0]?.foreign_keys;
  if (journalMode !== "wal") {
    driver.close();
    throw new Error("Messaging storage requires a durable file-backed database with WAL journal mode");
  }
  if (synchronous !== 2) {
    driver.close();
    throw new Error("Messaging storage requires synchronous = FULL");
  }
  if (foreignKeys !== 1) {
    driver.close();
    throw new Error("Messaging storage requires foreign_keys = ON");
  }

  for (const statement of MESSAGING_SQLITE_SCHEMA) driver.exec(statement);

  // Bind account + installation + schema version under one write lock. Checking
  // outside the transaction (or overwriting an existing binding) lets two
  // initializers end up sharing one file under different identities.
  driver.exec("begin immediate");
  try {
    const binding = new Map(
      driver.all<{ key: string; value: string }>(S.getMetaRows).map((row) => [row.key, row.value]),
    );
    const storedAccount = binding.get("account_id") ?? null;
    const storedDevice = binding.get("device_id") ?? null;
    const storedVersion = binding.get("schema_version") ?? null;
    if (storedVersion !== null && storedVersion !== String(MESSAGING_SQLITE_SCHEMA_VERSION)) {
      throw new Error("Unsupported messaging schema version");
    }
    if (storedAccount !== null && storedAccount !== scope.accountId) {
      throw new Error("Messaging database belongs to a different account");
    }
    if (storedDevice !== null && storedDevice !== scope.deviceId) {
      throw new Error("Messaging database belongs to a different installation");
    }
    driver.run(S.setMetaIfAbsent, ["account_id", scope.accountId]);
    driver.run(S.setMetaIfAbsent, ["device_id", scope.deviceId]);
    driver.run(S.setMetaIfAbsent, ["schema_version", String(MESSAGING_SQLITE_SCHEMA_VERSION)]);
    const confirmed = new Map(
      driver.all<{ key: string; value: string }>(S.getMetaRows).map((row) => [row.key, row.value]),
    );
    if (confirmed.get("account_id") !== scope.accountId || confirmed.get("device_id") !== scope.deviceId) {
      throw new Error("Messaging database binding conflict");
    }
    driver.exec("commit");
  } catch (error) {
    try { driver.exec("rollback"); } catch { /* transaction may already be gone */ }
    driver.close();
    throw error;
  }

  function assertOpen() {
    if (closed) throw new Error("Messaging history closed");
    const binding = new Map(
      driver.all<{ key: string; value: string }>(S.getMetaRows).map((row) => [row.key, row.value]),
    );
    if (binding.get("account_id") !== scope.accountId || binding.get("device_id") !== scope.deviceId) {
      throw new Error("Messaging database binding conflict");
    }
  }

  function transaction<T>(work: () => T): T {
    driver.exec("begin immediate");
    try {
      const result = work();
      driver.exec("commit");
      return result;
    } catch (error) {
      try { driver.exec("rollback"); } catch { /* commit may already have failed */ }
      throw error;
    }
  }

  function messageRow(id: string): MessageRow | undefined {
    return driver.all<MessageRow>(S.getMessage, [id])[0];
  }

  function tombstoneRow(id: string): TombstoneRow | undefined {
    return driver.all<TombstoneRow>(S.getTombstone, [id])[0];
  }

  function touch(conversationId: string, sequence: number) {
    driver.run(S.insertConversation, [conversationId, now(), now()]);
    driver.run(S.touchConversation, [sequence, now(), conversationId]);
  }

  function ensureConversation(conversationId: string) {
    driver.run(S.insertConversation, [conversationId, now(), now()]);
  }

  function assertTombstoneIdentity(tombstone: TombstoneRow, message: HumanMessage) {
    if (tombstone.conversationId !== message.conversationId || tombstone.unsentBy !== message.authorId) {
      throw new Error("Unsend identity conflict");
    }
  }

  async function enqueueOutgoing(message: HumanMessage): Promise<void> {
    const outgoing = copyMessage(message);
    assertOpen();
    if (outgoing.authorId !== scope.accountId) {
      throw new Error("Outgoing messaging scope mismatch");
    }
    transaction(() => {
      ensureConversation(outgoing.conversationId);
      const tombstone = tombstoneRow(outgoing.id);
      if (tombstone) assertTombstoneIdentity(tombstone, outgoing);

      const existing = messageRow(outgoing.id);
      if (existing) {
        if (!sameIdentity(existing, outgoing)) throw new Error("Immutable message identity conflict");
        if (existing.body !== null && existing.body !== outgoing.body) {
          throw new Error("Conflicting messaging message");
        }
        if (tombstone && existing.body !== null) {
          driver.run(S.clearMessageBody, [tombstone.unsentAt, outgoing.id]);
        }
        return;
      }
      if (tombstone) {
        // An authoritative unsend already exists: keep the identity, never the body,
        // and never queue an erased message for delivery.
        driver.run(S.insertTombstonedMessage, [
          outgoing.id, outgoing.conversationId, outgoing.authorId, outgoing.recipientId,
          now(), tombstone.unsentAt,
        ]);
        return;
      }
      driver.run(S.insertMessage, [
        outgoing.id, outgoing.conversationId, outgoing.authorId, outgoing.recipientId, outgoing.body, now(),
      ]);
      driver.run(S.enqueueOutbox, [outgoing.id]);
    });
  }

  async function getMessage(id: string): Promise<StoredHumanMessage | null> {
    assertOpen();
    const row = driver.all<MessageRow>(S.getVisibleMessage, [uuid(id)])[0];
    return row ? toStored(row) : null;
  }

  async function listMessages(conversationId: string): Promise<StoredHumanMessage[]> {
    assertOpen();
    return driver.all<MessageRow>(S.listMessages, [uuid(conversationId)]).map(toStored);
  }

  async function listOutbox(): Promise<OutboxEntry[]> {
    assertOpen();
    return driver.all<OutboxRow>(S.listOutbox).map((row) => {
      const entry: OutboxEntry = { messageId: row.messageId, status: row.status, attempts: row.attempts };
      if (row.token !== null) entry.token = row.token;
      if (row.leaseUntil !== null) entry.leaseUntil = row.leaseUntil;
      return entry;
    });
  }

  async function claimNextOutgoing(): Promise<OutgoingAttempt | null> {
    assertOpen();
    const token = tokenFactory();
    if (typeof token !== "string" || !token) throw new Error("Invalid messaging lease token");
    return transaction(() => {
      const nowMs = positiveTimestamp(now());
      const claimed = driver.all<{ messageId: string; attempts: number }>(S.claimOutbox, [
        token, nowMs + leaseMs, nowMs,
      ])[0];
      if (!claimed) return null;
      const row = messageRow(claimed.messageId);
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
    assertOpen();
    const message = copyMessage(attempt?.message);
    if (message.authorId !== scope.accountId) throw new Error("Invalid outgoing attempt scope");
    if (!Number.isSafeInteger(attempt?.attempt) || attempt.attempt < 1) {
      throw new Error("Invalid outgoing attempt generation");
    }
    const token = attempt.token;
    if (typeof token !== "string" || !token) throw new Error("Invalid messaging lease token");
    return transaction(() => {
      const row = messageRow(message.id);
      if (!row || !sameIdentity(row, message)) throw new Error("Outgoing attempt identity conflict");
      if (row.body === null) return false;
      // A failure must describe the exact immutable message that was leased.
      if (row.body !== message.body) throw new Error("Outgoing attempt identity conflict");
      return driver.run(S.failOutbox, [message.id, token, attempt.attempt]) === 1;
    });
  }

  function assertEnvelopeScope(envelope: MailboxEnvelope) {
    if (!envelope || envelope.accountId !== scope.accountId || envelope.deviceId !== scope.deviceId) {
      throw new Error("Messaging envelope is outside this installation scope");
    }
  }

  function persist(envelope: MailboxEnvelope): PersistenceReceipt {
    assertEnvelopeScope(envelope);
    const mailboxId = uuid(envelope.mailboxId);
    const eventId = uuid(envelope.event?.eventId);
    const sequence = positiveSequence(envelope.event?.sequence);
    if (envelope.event?.kind !== "TEXT") throw new Error("Unsupported messaging event");
    const message = copyMessage(envelope.event.message);
    if (message.authorId !== scope.accountId && message.recipientId !== scope.accountId) {
      throw new Error("Inbound participant scope mismatch");
    }

    return transaction(() => {
      const mailbox = driver.all<{ eventId: string; messageId: string; sequence: number }>(
        S.getMailboxEvent, [mailboxId],
      )[0];
      if (mailbox && (mailbox.eventId !== eventId || mailbox.messageId !== message.id || mailbox.sequence !== sequence)) {
        throw new Error("Immutable mailbox identity conflict");
      }
      const byEvent = driver.all<MessageRow>(S.getMessageByEvent, [eventId])[0];
      if (byEvent && (byEvent.id !== message.id
        || byEvent.conversationId !== message.conversationId
        || byEvent.sequence !== sequence)) {
        throw new Error("Immutable event identity conflict");
      }
      const tombstone = tombstoneRow(message.id);
      if (tombstone) assertTombstoneIdentity(tombstone, message);

      const existing = messageRow(message.id);
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
          driver.run(S.setMessageServer, [eventId, sequence, message.id]);
        }
      } else {
        ensureConversation(message.conversationId);
        if (tombstone) {
          driver.run(S.insertTombstonedMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId,
            now(), tombstone.unsentAt,
          ]);
        } else {
          driver.run(S.insertMessage, [
            message.id, message.conversationId, message.authorId, message.recipientId, message.body, now(),
          ]);
        }
        driver.run(S.setMessageServer, [eventId, sequence, message.id]);
      }

      // The stored identity owns the cursor, never a conflicting incoming tuple.
      touch(message.conversationId, sequence);
      if (!mailbox) {
        driver.run(S.insertMailboxEvent, [mailboxId, eventId, message.id, sequence, now()]);
      }
      // Only an echo of this account's own message confirms server success.
      if (message.authorId === scope.accountId) driver.run(S.deleteOutbox, [message.id]);
      return { ...scope, mailboxId, eventId };
    });
  }

  async function persistInbound(envelope: MailboxEnvelope): Promise<PersistenceReceipt> {
    assertOpen();
    return persist(envelope);
  }

  async function persistInboundAndAck(
    envelope: MailboxEnvelope,
    ack: (receipt: PersistenceReceipt) => Promise<void>,
  ): Promise<void> {
    assertOpen();
    const receipt = persist(envelope);
    assertOpen();
    await ack(receipt);
  }

  async function recordUnsend(tombstone: {
    messageId: string; conversationId: string; unsentAt: number; unsentBy: string;
  }): Promise<void> {
    assertOpen();
    const messageId = uuid(tombstone?.messageId);
    const conversationId = uuid(tombstone?.conversationId);
    const unsentBy = uuid(tombstone?.unsentBy);
    const unsentAt = positiveTimestamp(tombstone?.unsentAt);
    transaction(() => {
      const existing = messageRow(messageId);
      if (existing) {
        if (existing.conversationId !== conversationId) throw new Error("Unsend conversation conflict");
        if (existing.authorId !== unsentBy) throw new Error("Unsend author conflict");
      }
      const prior = tombstoneRow(messageId);
      if (prior) {
        if (prior.conversationId !== conversationId || prior.unsentBy !== unsentBy) {
          throw new Error("Unsend identity conflict");
        }
      } else {
        driver.run(S.insertTombstone, [messageId, conversationId, unsentAt, unsentBy]);
      }
      if (existing && existing.body !== null) {
        driver.run(S.clearMessageBody, [unsentAt, messageId]);
      }
      // An unsent message must never be leased for delivery.
      driver.run(S.deleteOutbox, [messageId]);
    });
  }

  async function deleteForMe(messageId: string): Promise<void> {
    assertOpen();
    const id = uuid(messageId);
    transaction(() => {
      const existing = messageRow(id);
      if (existing && existing.authorId !== scope.accountId && existing.recipientId !== scope.accountId) {
        throw new Error("Delete-for-me scope mismatch");
      }
      driver.run(S.deleteForMe, [id, existing ? existing.conversationId : null, now()]);
    });
  }

  async function clearThrough(conversationId: string, throughSequence: number): Promise<void> {
    assertOpen();
    const id = uuid(conversationId);
    const through = positiveSequence(throughSequence);
    transaction(() => {
      ensureConversation(id);
      driver.run(S.clearConversation, [id, through, now()]);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    driver.close();
  }

  return {
    enqueueOutgoing, getMessage, listMessages, listOutbox, claimNextOutgoing, failOutgoing,
    persistInbound, persistInboundAndAck, close,
    recordUnsend, deleteForMe, clearThrough,
  };
}
