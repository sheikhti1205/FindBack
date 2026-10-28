/**
 * Android/SQLite local history schema for human messaging (R3 §7, §8, §9, §10).
 *
 * This module is pure SQL text plus a driver-neutral statement map. It contains no
 * driver import, so the mobile bundle never pulls a Node-only SQLite binding. The
 * adapter in `sqliteHistory.ts` takes an injected driver; the Android Capacitor
 * plugin is a thin transport driver, and host tests use a real SQLite engine.
 *
 * Durability: `synchronous = FULL` with WAL is the strictest useful SQLite setting,
 * but it is still a filesystem/OS promise, not measured power-loss proof. The
 * adapter verifies the pragmas actually took effect and rejects a non-file-backed
 * connection before it can issue a persistence receipt.
 */

/**
 * v4: `tombstones` binds the recipient as well as the conversation and author, so
 * a wrong-recipient unsend can no longer erase an unrelated message id. v1–v3
 * files are migrated additively; rows written before v4 keep a NULL recipient and
 * are validated on the fields they actually carry.
 *
 * v5: `messages.body` admits the empty string, because an image-only message has
 * no caption. The old CHECK (`length(body) between 1 and 100000`) cannot be
 * altered in place, so v5 rebuilds the table with SQLite's documented procedure
 * and proves the copy is exact before dropping the original.
 */
export const MESSAGING_SQLITE_SCHEMA_VERSION = 5;

/**
 * The v5 `messages` body CHECK, recognised in `sqlite_master`.
 *
 * The rebuild is triggered when this text is ABSENT, not when the old text is
 * present. That direction is deliberate: a whitespace or casing change in some
 * future build's DDL would make a positive match silently skip the migration and
 * leave a file stamped v5 that still rejects `''`. Absence is the safe default,
 * and re-running the rebuild on an already-correct table is harmless — the copy
 * is proven exact and nothing is dropped until it is.
 */
export const MESSAGES_V5_BODY_CHECK = "length(body) <= 100000";

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
    -- v5: an image-only message carries no caption, so the empty string is a
    -- valid body. Anything longer than the storage bound is still refused.
    check (body is null or length(body) <= 100000),
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
    recipient_id text,
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
  `create table if not exists conversation_state (
    conversation_id text primary key references conversations(id) on delete cascade,
    peer_id text not null,
    read_through integer not null default 0 check (read_through >= 0),
    updated_at integer not null default 0,
    projection_json text,
    observed_at integer
  )`,
  `create table if not exists messaging_state_events (
    event_id text primary key,
    sequence integer not null unique,
    change_json text not null
  )`,
] as const;

const MESSAGE_COLUMNS = `m.id as id, m.conversation_id as conversationId,
  m.author_id as authorId, m.recipient_id as recipientId, m.body as body,
  m.server_event_id as eventId, m.server_sequence as sequence, m.unsent_at as unsentAt`;

export const MESSAGING_SQLITE_STATEMENTS = {
  getMeta: `select value from messaging_meta where key = ?`,
  getStateCursor: `select event_id as eventId, sequence from messaging_state_events order by sequence desc limit 1`,
  getStateEvent: `select sequence, change_json as changeJson from messaging_state_events where event_id = ?`,
  insertStateEvent: `insert into messaging_state_events(event_id,sequence,change_json) values(?,?,?)`,
  erasePersonalMessage: `update messages set body=null where id=?`,
  erasePersonalConversation: `update messages set body=null where conversation_id=? and server_sequence<=?`,
  getMetaRows: `select key, value from messaging_meta
    where key in ('account_id', 'device_id', 'schema_version')`,
  setMetaIfAbsent: `insert or ignore into messaging_meta (key, value) values (?, ?)`,
  setSchemaVersion: `update messaging_meta set value = ? where key = 'schema_version'`,
  insertConversation: `insert or ignore into conversations (id, created_at, updated_at)
    values (?, ?, ?)`,
  getLastSequence: `select last_sequence as lastSequence from conversations where id = ?`,
  touchConversation: `update conversations
    set last_sequence = max(last_sequence, ?), updated_at = ?
    where id = ?`,
  insertConversationState: `insert or ignore into conversation_state (conversation_id, peer_id)
    values (?, ?)`,
  getConversationState: `select conversation_id as conversationId, peer_id as peerId,
    read_through as readThrough, updated_at as updatedAt, projection_json as projectionJson,
    observed_at as observedAt from conversation_state where conversation_id = ?`,
  listConversationStates: `select conversation_id as conversationId, peer_id as peerId,
    read_through as readThrough, updated_at as updatedAt, projection_json as projectionJson,
    observed_at as observedAt from conversation_state`,
  getConversationParticipants: `select distinct author_id as authorId, recipient_id as recipientId
    from messages where conversation_id = ?`,
  touchConversationState: `update conversation_state set updated_at = ? where conversation_id = ?`,
  cacheConversation: `update conversation_state set projection_json = ?, observed_at = ? where conversation_id = ?`,
  markConversationRead: `update conversation_state set read_through = max(read_through, ?) where conversation_id = ?`,
  maxConversationSequence: `select coalesce(max(server_sequence), 0) as sequence from messages where conversation_id = ?`,
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
  listInboxMessages: `select ${MESSAGE_COLUMNS} from messages m
    where not exists (select 1 from deleted_for_me d where d.message_id = m.id)
      and (m.server_sequence is null or m.server_sequence > coalesce(
        (select c.through_sequence from conversation_cleared c
          where c.conversation_id = m.conversation_id), 0))`,
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
    recipient_id as recipientId, unsent_at as unsentAt, unsent_by as unsentBy
    from tombstones where message_id = ?`,
  insertTombstone: `insert into tombstones (message_id, conversation_id, recipient_id, unsent_at, unsent_by)
    values (?, ?, ?, ?, ?)`,
  // Additive v1–v3 -> v4 migration. `pragma table_info` decides whether the
  // column already exists; SQLite has no `add column if not exists`.
  tombstoneColumns: `pragma table_info(tombstones)`,
  addTombstoneRecipient: `alter table tombstones add column recipient_id text`,
  /** Legacy v3 tombstone gains its recipient once an authoritative event names it. */
  bindTombstoneRecipient: `update tombstones set recipient_id = ?
    where message_id = ? and recipient_id is null`,
  enqueueOutbox: `insert or ignore into outbox (message_id, status) values (?, 'QUEUED')`,
  listOutbox: `select message_id as messageId, status, attempts, token,
    lease_until as leaseUntil from outbox order by message_id`,
  // Android24 ships SQLite older than RETURNING/UPSERT. The adapter executes
  // selection/claim/read-back under BEGIN IMMEDIATE, not as independent writes.
  nextOutbox: `
       select o.message_id as messageId from outbox o
        join messages m on m.id = o.message_id
      where (o.status in ('QUEUED', 'FAILED')
          or (o.status = 'SENDING' and o.lease_until <= ?))
        and m.body is not null
        and m.unsent_at is null
        and m.server_event_id is null
      order by o.message_id
      limit 1
    `,
  claimOutbox: `update outbox
    set status = 'SENDING', token = ?, lease_until = ?, attempts = attempts + 1
    where message_id = ?`,
  getOutboxClaim: `select message_id as messageId, attempts from outbox where message_id = ?`,
  failOutbox: `update outbox set status = 'FAILED', token = null, lease_until = null
    where message_id = ? and token = ? and attempts = ? and status = 'SENDING'`,
  completeOutbox: `delete from outbox where message_id = ?`,
  deleteOutbox: `delete from outbox where message_id = ?`,
  deleteForMe: `insert or ignore into deleted_for_me (message_id, conversation_id, deleted_at)
    values (?, ?, ?)`,
  isDeletedForMe: `select 1 as present from deleted_for_me where message_id = ?`,
  getDeletedForMe: `select conversation_id as conversationId from deleted_for_me where message_id = ?`,
  getClearThrough: `select through_sequence as throughSequence from conversation_cleared where conversation_id=?`,
  insertClearConversation: `insert or ignore into conversation_cleared (conversation_id, through_sequence, cleared_at)
    values (?, ?, ?)`,
  clearConversation: `update conversation_cleared
    set through_sequence = max(through_sequence, ?), cleared_at = ? where conversation_id = ?`,

  // ---- v4 -> v5: messages.body admits '' (image-only caption) ----
  /** Fingerprint of the live table; the CHECK cannot be altered in place. */
  messagesTableSql: `select sql from sqlite_master where type = 'table' and name = 'messages'`,
  /** The same columns and constraints, with the body CHECK relaxed to <= 100000. */
  createMessagesV5: `create table messages_v5 (
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
    check (body is null or length(body) <= 100000),
    check ((server_event_id is null) = (server_sequence is null)),
    unique (conversation_id, server_sequence)
  )`,
  copyMessagesV5: `insert into messages_v5
    (id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at)
    select id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at from messages`,
  // Exact set comparison over every column, in both directions. A count alone
  // would accept a copy that silently dropped one row and duplicated another.
  missingMessagesV5: `select count(*) as n from (
    select id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at from messages
    except
    select id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at from messages_v5)`,
  extraMessagesV5: `select count(*) as n from (
    select id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at from messages_v5
    except
    select id, conversation_id, author_id, recipient_id, body, server_event_id,
      server_sequence, created_at, unsent_at from messages)`,
  dropMessages: `drop table messages`,
  renameMessagesV5: `alter table messages_v5 rename to messages`,
  // Indexes are dropped with their table, so both are recreated by name.
  recreateMessagesEventIndex: `create unique index if not exists ux_messages_event
    on messages(server_event_id) where server_event_id is not null`,
  recreateMessagesConversationIndex: `create index if not exists ix_messages_conversation
    on messages(conversation_id, server_sequence)`,
  /** Foreign keys are off during the rebuild, so integrity is proven afterwards. */
  foreignKeyCheck: `pragma foreign_key_check`,

  // ---- portable history snapshot (backup/restore) ----
  // Only accepted messages are portable: a pending send is device-local work,
  // not history, and must never be re-sent by a restore.
  listSnapshotConversations: `select id, last_sequence as lastSequence,
    created_at as createdAt, updated_at as updatedAt from conversations`,
  listSnapshotMessages: `select ${MESSAGE_COLUMNS}, m.created_at as createdAt from messages m
    where m.server_event_id is not null and m.server_sequence is not null`,
  listSnapshotTombstones: `select message_id as messageId, conversation_id as conversationId,
    recipient_id as recipientId, unsent_at as unsentAt, unsent_by as unsentBy from tombstones`,
  listSnapshotDeletedForMe: `select message_id as messageId, conversation_id as conversationId,
    deleted_at as deletedAt from deleted_for_me`,
  listSnapshotClears: `select conversation_id as conversationId,
    through_sequence as throughSequence, cleared_at as clearedAt from conversation_cleared`,
  /** Deterministic and commutative: min creation, max activity, max sequence. */
  mergeConversation: `update conversations
    set last_sequence = max(last_sequence, ?), updated_at = max(updated_at, ?),
      created_at = min(created_at, ?) where id = ?`,
  getConversationCreated: `select created_at as createdAt from conversations where id = ?`,
  getSnapshotMessage: `select ${MESSAGE_COLUMNS}, m.created_at as createdAt
    from messages m where m.id = ?`,
  /** One unsend is one event: the message adopts the tombstone's stamp if it has none. */
  setMessageUnsentAt: `update messages set unsent_at = ?
    where id = ? and unsent_at is null`,
  // Two different messages cannot occupy the same (conversation, sequence), so a
  // snapshot claiming one is contradicting this store, not merely adding to it.
  getMessageAtSequence: `select id from messages
    where conversation_id = ? and server_sequence = ?`,
  insertSnapshotMessage: `insert into messages
    (id, conversation_id, author_id, recipient_id, body, created_at,
      server_event_id, server_sequence, unsent_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateSnapshotMessage: `update messages set body = ?, unsent_at = ?, created_at = ?
    where id = ?`,
  /** Union by message id, with a commutative tie-break on both metadata columns. */
  mergeDeletedForMe: `update deleted_for_me
    set conversation_id = coalesce(conversation_id, ?), deleted_at = min(deleted_at, ?)
    where message_id = ?`,
  mergeClear: `update conversation_cleared
    set through_sequence = max(through_sequence, ?), cleared_at = max(cleared_at, ?)
    where conversation_id = ?`,
  // Anti-resurrection backstop, run inside the import transaction: no path may
  // leave a body visible behind a tombstone, a personal deletion or a clear.
  suppressTombstonedBodies: `update messages set body = null
    where body is not null and id in (select message_id from tombstones)`,
  suppressDeletedBodies: `update messages set body = null
    where body is not null and id in (select message_id from deleted_for_me)`,
  /** An unsent message is never readable, whether or not its tombstone travelled. */
  suppressUnsentBodies: `update messages set body = null
    where body is not null and unsent_at is not null`,
  suppressClearedBodies: `update messages set body = null
    where body is not null and server_sequence is not null
      and exists (select 1 from conversation_cleared c
        where c.conversation_id = messages.conversation_id
          and messages.server_sequence <= c.through_sequence)`,
} as const;

export type MessagingStatement = keyof typeof MESSAGING_SQLITE_STATEMENTS;
