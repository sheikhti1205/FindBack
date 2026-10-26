/**
 * Android/SQLite local history schema for human messaging (R3 §7, §8, §9, §10).
 *
 * This module is pure SQL text plus a driver-neutral statement map. It contains no
 * driver import, so the mobile bundle never pulls a Node-only SQLite binding. The
 * adapter in `sqliteHistory.ts` takes an injected driver; the Capacitor SQLite
 * bridge becomes a thin driver later, and tests use a real SQLite engine.
 *
 * Durability: `synchronous = FULL` with WAL is the strictest useful SQLite setting,
 * but it is still a filesystem/OS promise, not measured power-loss proof. The
 * adapter verifies the pragmas actually took effect and rejects a non-file-backed
 * connection before it can issue a persistence receipt.
 */

export const MESSAGING_SQLITE_SCHEMA_VERSION = 1;

export const MESSAGING_SQLITE_PRAGMAS = [
  "pragma journal_mode = wal",
  "pragma synchronous = full",
  "pragma foreign_keys = on",
  "pragma busy_timeout = 5000",
] as const;

/**
 * Read back after the pragmas. Issuing a pragma is not proof it applied: SQLite
 * returns the previous journal mode when the change fails, and an in-memory
 * database can never enter WAL.
 */
export const MESSAGING_SQLITE_DURABILITY_CHECKS = {
  journalMode: "pragma journal_mode",
  synchronous: "pragma synchronous",
  foreignKeys: "pragma foreign_keys",
} as const;

export const MESSAGING_SQLITE_SCHEMA = [
  `create table if not exists messaging_meta (
    key text primary key,
    value text not null
  )`,
  `create table if not exists conversations (
    id text primary key,
    last_sequence integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  )`,
  `create table if not exists messages (
    id text primary key,
    conversation_id text not null references conversations(id) on delete cascade,
    author_id text not null,
    recipient_id text not null,
    body text,
    server_event_id text,
    server_sequence integer,
    created_at integer not null,
    unsent_at integer,
    check (author_id <> recipient_id),
    check (body is null or (length(body) between 1 and 100000)),
    check ((server_event_id is null) = (server_sequence is null)),
    unique (conversation_id, server_sequence)
  )`,
  // One authoritative event may identify exactly one stored message.
  `create unique index if not exists ux_messages_event
    on messages(server_event_id) where server_event_id is not null`,
  `create index if not exists ix_messages_conversation
    on messages(conversation_id, server_sequence)`,
  `create table if not exists outbox (
    message_id text primary key references messages(id) on delete cascade,
    status text not null check (status in ('QUEUED','SENDING','FAILED')),
    attempts integer not null default 0,
    token text,
    lease_until integer,
    check ((status = 'SENDING') = (token is not null and lease_until is not null))
  )`,
  // Identity of every applied envelope, validated before any receipt or ACK.
  `create table if not exists mailbox_seen (
    mailbox_id text primary key,
    event_id text not null,
    message_id text not null,
    sequence integer not null,
    applied_at integer not null
  )`,
  `create table if not exists tombstones (
    message_id text primary key,
    conversation_id text not null,
    unsent_at integer not null,
    unsent_by text not null
  )`,
  // Deliberately no foreign key: a same-user deletion event may arrive before the
  // message content it hides (R3 §9 restore ordering).
  `create table if not exists deleted_for_me (
    message_id text primary key,
    conversation_id text,
    deleted_at integer not null
  )`,
  `create table if not exists conversation_cleared (
    conversation_id text primary key references conversations(id) on delete cascade,
    through_sequence integer not null,
    cleared_at integer not null
  )`,
] as const;

const MESSAGE_COLUMNS = `m.id as id, m.conversation_id as conversationId,
  m.author_id as authorId, m.recipient_id as recipientId, m.body as body,
  m.server_event_id as eventId, m.server_sequence as sequence, m.unsent_at as unsentAt`;

export const MESSAGING_SQLITE_STATEMENTS = {
  getMeta: `select value from messaging_meta where key = ?`,
  getMetaRows: `select key, value from messaging_meta
    where key in ('account_id', 'device_id', 'schema_version')`,
  setMetaIfAbsent: `insert into messaging_meta (key, value) values (?, ?)
    on conflict (key) do nothing`,
  insertConversation: `insert or ignore into conversations (id, created_at, updated_at)
    values (?, ?, ?)`,
  getLastSequence: `select last_sequence as lastSequence from conversations where id = ?`,
  touchConversation: `update conversations
    set last_sequence = max(last_sequence, ?), updated_at = ?
    where id = ?`,
  /** Internal identity lookup: ignores personal visibility. */
  getMessage: `select ${MESSAGE_COLUMNS} from messages m where m.id = ?`,
  /** Consumer read: honours delete-for-me and clear-through. */
  getVisibleMessage: `select ${MESSAGE_COLUMNS} from messages m
    where m.id = ?
      and not exists (select 1 from deleted_for_me d where d.message_id = m.id)
      and (m.server_sequence is null or m.server_sequence > coalesce(
        (select c.through_sequence from conversation_cleared c
          where c.conversation_id = m.conversation_id), 0))`,
  listMessages: `select ${MESSAGE_COLUMNS} from messages m
    where m.conversation_id = ?
      and not exists (select 1 from deleted_for_me d where d.message_id = m.id)
      and (m.server_sequence is null or m.server_sequence > coalesce(
        (select c.through_sequence from conversation_cleared c
          where c.conversation_id = m.conversation_id), 0))
    order by (m.server_sequence is null), m.server_sequence, m.created_at`,
  getMessageByEvent: `select ${MESSAGE_COLUMNS} from messages m
    where m.server_event_id = ?`,
  insertMessage: `insert into messages
    (id, conversation_id, author_id, recipient_id, body, created_at)
    values (?, ?, ?, ?, ?, ?)`,
  insertTombstonedMessage: `insert into messages
    (id, conversation_id, author_id, recipient_id, body, created_at, unsent_at)
    values (?, ?, ?, ?, null, ?, ?)`,
  setMessageServer: `update messages set server_event_id = ?, server_sequence = ?
    where id = ? and server_event_id is null`,
  clearMessageBody: `update messages set body = null, unsent_at = coalesce(unsent_at, ?)
    where id = ?`,
  getMailboxEvent: `select event_id as eventId, message_id as messageId, sequence
    from mailbox_seen where mailbox_id = ?`,
  insertMailboxEvent: `insert into mailbox_seen
    (mailbox_id, event_id, message_id, sequence, applied_at)
    values (?, ?, ?, ?, ?)`,
  getTombstone: `select message_id as messageId, conversation_id as conversationId,
    unsent_at as unsentAt, unsent_by as unsentBy from tombstones where message_id = ?`,
  insertTombstone: `insert into tombstones (message_id, conversation_id, unsent_at, unsent_by)
    values (?, ?, ?, ?)`,
  enqueueOutbox: `insert or ignore into outbox (message_id, status) values (?, 'QUEUED')`,
  listOutbox: `select message_id as messageId, status, attempts, token,
    lease_until as leaseUntil from outbox order by message_id`,
  claimOutbox: `update outbox
    set status = 'SENDING', token = ?, lease_until = ?, attempts = attempts + 1
    where message_id = (
      select o.message_id from outbox o
        join messages m on m.id = o.message_id
      where (o.status in ('QUEUED', 'FAILED')
          or (o.status = 'SENDING' and o.lease_until <= ?))
        and m.body is not null
        and m.unsent_at is null
        and m.server_event_id is null
      order by o.message_id
      limit 1
    )
    returning message_id as messageId, attempts`,
  failOutbox: `update outbox set status = 'FAILED', token = null, lease_until = null
    where message_id = ? and token = ? and attempts = ? and status = 'SENDING'`,
  completeOutbox: `delete from outbox where message_id = ?`,
  deleteOutbox: `delete from outbox where message_id = ?`,
  deleteForMe: `insert into deleted_for_me (message_id, conversation_id, deleted_at)
    values (?, ?, ?) on conflict (message_id) do nothing`,
  isDeletedForMe: `select 1 as present from deleted_for_me where message_id = ?`,
  clearConversation: `insert into conversation_cleared (conversation_id, through_sequence, cleared_at)
    values (?, ?, ?)
    on conflict (conversation_id) do update
      set through_sequence = max(through_sequence, excluded.through_sequence),
          cleared_at = excluded.cleared_at`,
} as const;

export type MessagingStatement = keyof typeof MESSAGING_SQLITE_STATEMENTS;
