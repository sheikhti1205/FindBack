// @vitest-environment node
/**
 * Real SQLite execution of the Android local-history schema/statements.
 * Proves SQL constraints and adapter behaviour; not the Capacitor bridge, an
 * Android device build, or power-loss durability.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanMessage, MailboxEnvelope } from "./history";
import { openSqliteMessagingHistory, type SqliteDriver, type SqliteHistoryOptions } from "./sqliteHistory";
import { MESSAGING_SQLITE_SCHEMA, MESSAGING_SQLITE_SCHEMA_VERSION, MESSAGING_SQLITE_STATEMENTS as S } from "./sqliteSchema";
import { MEDIA_SWEEP_GRACE_MS } from "./media";
import { afterNextHistoryOperation, deferred, FakeMediaBytes, mediaBytes, mediaFixture } from "./mediaTestDoubles";
import type { StateChangeEnvelope } from "./stateChanges";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const DEVICE = "00000000-0000-4000-8000-000000000004";
const OTHER_DEVICE = "00000000-0000-4000-8000-000000000005";
const CONVERSATION = "00000000-0000-4000-8000-000000000006";
const OTHER_CONVERSATION = "00000000-0000-4000-8000-000000000007";
const MESSAGE = "00000000-0000-4000-8000-000000000008";
const MESSAGE_2 = "00000000-0000-4000-8000-000000000009";
const EVENT = "00000000-0000-4000-8000-00000000000a";
const EVENT_2 = "00000000-0000-4000-8000-00000000000b";
const MAILBOX = "00000000-0000-4000-8000-00000000000c";
const MAILBOX_2 = "00000000-0000-4000-8000-00000000000d";

let dir: string;
let path: string;
let database: DatabaseSync;
let clock: number;

function driverFor(db: DatabaseSync, beforeStatement?: (sql: string) => void | Promise<void>): SqliteDriver {
  return {
    exec: async (sql) => {
      await beforeStatement?.(sql);
      db.exec(sql);
    },
    all: (sql, params = []) => {
      beforeStatement?.(sql);
      return db.prepare(sql).all(...params) as never;
    },
    run: (sql, params = []) => {
      beforeStatement?.(sql);
      return Number(db.prepare(sql).run(...params).changes);
    },
    close: () => db.close(),
  };
}

function openOn(
  db: DatabaseSync,
  identity = { accountId: A, deviceId: DEVICE },
  options: SqliteHistoryOptions = {},
  beforeExec?: (sql: string) => void | Promise<void>,
) {
  return openSqliteMessagingHistory(driverFor(db, beforeExec), identity, {
    now: () => clock,
    token: () => `token-${clock}`,
    ...options,
  });
}

function open(beforeExec?: (sql: string) => void | Promise<void>) {
  return openOn(database, { accountId: A, deviceId: DEVICE }, {}, beforeExec);
}

function rawBodies(): string[] {
  const reader = new DatabaseSync(path);
  try {
    return (reader.prepare("select body from messages order by id").all() as { body: string | null }[])
      .map((row) => row.body ?? "<null>");
  } finally {
    reader.close();
  }
}

function rawCount(
  table: "messages" | "mailbox_seen" | "conversations" | "outbox" | "media_attachments",
): number {
  const reader = new DatabaseSync(path);
  try {
    return Number((reader.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
  } finally {
    reader.close();
  }
}

const outgoing: HumanMessage = {
  id: MESSAGE, conversationId: CONVERSATION, authorId: A, recipientId: B, body: "Hello there",
};

function echoOf(message: HumanMessage = outgoing, event = EVENT, mailbox = MAILBOX, sequence = 1): MailboxEnvelope {
  return {
    accountId: A,
    deviceId: DEVICE,
    mailboxId: mailbox,
    event: { kind: "TEXT", eventId: event, sequence, message },
  };
}

function inbound(message: Partial<HumanMessage> = {}, event = EVENT, mailbox = MAILBOX, sequence = 1): MailboxEnvelope {
  return echoOf({ ...outgoing, authorId: B, recipientId: A, body: "Reply text", ...message }, event, mailbox, sequence);
}

/**
 * Build a v4-shaped file: today's schema, except `messages` still carries the
 * body CHECK that rejects the empty string, plus one accepted message and its
 * pending outbox row.
 */
function seedLegacyV4() {
  database.exec("create table messaging_meta (key text primary key, value text not null)");
  const bind = database.prepare("insert into messaging_meta (key, value) values (?, ?)");
  bind.run("account_id", A);
  bind.run("device_id", DEVICE);
  bind.run("schema_version", "4");
  // The messages table and its indexes are created by hand below, in their v4
  // shape, so the schema's own definitions for them are skipped.
  const ownedByMessages = [
    "create table if not exists messages (",
    "create unique index if not exists ux_messages_event",
    "create index if not exists ix_messages_conversation",
  ];
  for (const statement of MESSAGING_SQLITE_SCHEMA as readonly string[]) {
    if (!ownedByMessages.some((prefix) => statement.startsWith(prefix))) database.exec(statement);
  }
  database.exec(`create table messages (
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
    unique (conversation_id, server_sequence))`);
  database.exec("create unique index ux_messages_event on messages(server_event_id) where server_event_id is not null");
  database.exec("create index ix_messages_conversation on messages(conversation_id, server_sequence)");
  database.prepare("insert into conversations (id, created_at, updated_at) values (?,?,?)").run(CONVERSATION, 1, 1);
  database.prepare(`insert into messages
    (id, conversation_id, author_id, recipient_id, body, server_event_id, server_sequence, created_at)
    values (?,?,?,?,?,?,?,?)`).run(MESSAGE, CONVERSATION, A, B, "Hello there", EVENT, 1, 5);
  database.prepare("insert into outbox (message_id, status) values (?, 'QUEUED')").run(MESSAGE);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "findback-sqlite-"));
  path = join(dir, "messaging.db");
  database = new DatabaseSync(path);
  clock = 1_700_000_000_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  try { database.close(); } catch { /* already closed by the adapter */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("schema and durability", () => {
  it("exports only accepted history and restores it without producing mailbox or outbox work", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.enqueueOutgoing({ ...outgoing, id: MESSAGE_2 });
    const snapshot = await history.exportSnapshot();
    expect(snapshot.messages.map((message) => message.id)).toEqual([MESSAGE]);
    await history.close();
    const otherDatabase = new DatabaseSync(join(dir, "restore.db"));
    const restored = await openOn(otherDatabase, { accountId: A, deviceId: OTHER_DEVICE });
    await restored.importSnapshot(snapshot);
    expect(await restored.getMessage(MESSAGE)).toMatchObject({ body: "Reply text" });
    expect(await restored.getMessage(MESSAGE_2)).toBeNull();
    expect(await restored.listOutbox()).toEqual([]);
    expect(otherDatabase.prepare("select count(*) as n from mailbox_seen").get()).toEqual({ n: 0 });
    await restored.close();
  });

  it("verifies WAL, full synchronous durability and enforced foreign keys on its own connection", async () => {
    const history = await open();
    expect(database.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("pragma synchronous").get()).toEqual({ synchronous: 2 });
    expect(database.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    await history.close();
  });

  it("refuses an in-memory database instead of issuing durable receipts from it", async () => {
    const memory = new DatabaseSync(":memory:");
    await expect(openOn(memory)).rejects.toThrow(/durable file-backed database/);
    expect(() => memory.prepare("select 1").get()).toThrow();
  });

  it("refuses an unsupported future schema version rather than downgrading it", async () => {
    database.exec("create table messaging_meta (key text primary key, value text not null)");
    database.prepare("insert into messaging_meta (key, value) values (?, ?)")
      .run("schema_version", String(MESSAGING_SQLITE_SCHEMA_VERSION + 1));
    database = new DatabaseSync(path);
    await expect(open()).rejects.toThrow(/Unsupported messaging schema version/);
    database = new DatabaseSync(path);
    expect(database.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(database.prepare("select name from sqlite_master where type = 'table' and name = 'conversations'").get())
      .toBeUndefined();
  });

  it("migrates a v3 file additively and keeps a legacy tombstone usable", async () => {
    database.exec("create table messaging_meta (key text primary key, value text not null)");
    const bind = database.prepare("insert into messaging_meta (key, value) values (?, ?)");
    bind.run("account_id", A);
    bind.run("device_id", DEVICE);
    bind.run("schema_version", "3");
    database.exec(`create table tombstones (
      message_id text primary key, conversation_id text not null,
      unsent_at integer not null, unsent_by text not null)`);
    database.prepare("insert into tombstones (message_id, conversation_id, unsent_at, unsent_by) values (?,?,?,?)")
      .run(MESSAGE, CONVERSATION, clock, B);

    const history = await open();
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    const columns = (database.prepare("pragma table_info(tombstones)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain("recipient_id");
    // The legacy row is unbound. The authoritative envelope binds it in the same
    // transaction that suppresses the body, so NULL never acts as a wildcard
    // after the first real record of the message.
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    expect(database.prepare("select recipient_id as recipientId from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ recipientId: A });
    // A later authoritative unsend for the same identity is an idempotent confirm.
    await history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A, unsentAt: clock, unsentBy: B,
    });
    expect(database.prepare("select recipient_id as recipientId from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ recipientId: A });
    await history.close();
  });

  it("rebuilds a v4 messages table so an image-only message can be stored, preserving every row", async () => {
    seedLegacyV4();
    // The old shape is what makes this a real migration rather than a no-op.
    expect(() => database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE_2, CONVERSATION, A, B, "", 6)).toThrow(/CHECK/);

    const history = await open();
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    // Every existing row and its pending send survived the rebuild.
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there", server: { sequence: 1 } });
    expect((await history.listOutbox()).map((entry) => entry.messageId)).toEqual([MESSAGE]);
    // The rebuilt table accepts the empty caption, and the indexes exist again.
    database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE_2, CONVERSATION, A, B, "", 6);
    const indexRows = database.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'messages'")
      .all() as Array<{ name: string }>;
    const indexes = indexRows.map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["ux_messages_event", "ix_messages_conversation"]));
    expect(database.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(database.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    // Still bounded above: the rebuild relaxed the floor, not the ceiling.
    expect(() => database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE, CONVERSATION, A, B, "x".repeat(100_001), 7)).toThrow(/CHECK/);
    await history.close();
  });

  it("refuses to drop the original table when the v5 copy is not exact", async () => {
    seedLegacyV4();
    // Simulate a lossy copy: remove a row after it was copied, before the
    // verification query runs. The rebuild must notice and refuse.
    let corrupted = false;
    const issued: string[] = [];
    await expect(open((sql) => {
      issued.push(sql);
      if (!corrupted && sql.includes("except") && sql.includes("from messages_v5)")) {
        corrupted = true;
        database.prepare("delete from messages_v5 where id = ?").run(MESSAGE);
      }
    })).rejects.toThrow(/did not preserve every message/);
    expect(corrupted).toBe(true);
    // The pragma is restored by an issued statement, not by the engine's default.
    expect(issued).toContain("pragma foreign_keys = on");
    // It was issued after the copy was attempted, i.e. on the failure path.
    expect(issued.lastIndexOf("pragma foreign_keys = on")).toBeGreaterThan(issued.indexOf("drop table messages"));
    // The adapter closed its handle on failure, so reopen the file to inspect it.
    database = new DatabaseSync(path);
    // Rolled back: the original table, its CHECK and its row are untouched.
    expect(database.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: "Hello there" });
    expect(database.prepare("select name from sqlite_master where type = 'table' and name = 'messages_v5'").get())
      .toBeUndefined();
    expect(() => database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE_2, CONVERSATION, A, B, "", 6)).toThrow(/CHECK/);
    expect(database.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("rebuilds a pre-v5 table even when its DDL is formatted differently", async () => {
    // The trigger is the ABSENCE of the v5 CHECK, so a build that emitted the
    // old constraint with different whitespace still migrates. Matching the old
    // text positively would silently skip it and leave a v5-stamped file that
    // rejects an image-only message at runtime.
    seedLegacyV4();
    database.exec("drop index ix_messages_conversation");
    database.exec("drop index ux_messages_event");
    database.exec("drop table messages");
    database.exec(`CREATE TABLE messages(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL, recipient_id TEXT NOT NULL, body TEXT,
      server_event_id TEXT, server_sequence INTEGER, created_at INTEGER NOT NULL,
      unsent_at INTEGER,
      CHECK(author_id<>recipient_id),
      CHECK(body IS NULL OR (LENGTH(body) BETWEEN 1 AND 100000)),
      CHECK((server_event_id IS NULL)=(server_sequence IS NULL)),
      UNIQUE(conversation_id, server_sequence))`);
    database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE, CONVERSATION, A, B, "Hello there", 5);

    const history = await open();
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    database.prepare(`insert into messages
      (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
      .run(MESSAGE_2, CONVERSATION, A, B, "", 6);
    await history.close();
  });

  it("does not rebuild a table that already carries the v5 CHECK", async () => {
    const issued: string[] = [];
    const history = await open((sql) => { issued.push(sql); });
    expect(issued.some((sql) => sql.startsWith("create table messages_v5"))).toBe(false);
    expect(issued).not.toContain("drop table messages");
    await history.close();
  });

  it("refuses a v5 copy that gained a row as well as one that lost a row", async () => {
    // The missing-row direction is covered above. The proof is two-way, so the
    // extra-row direction must also be shown to fire: a count-based check would
    // accept a copy that dropped one row and duplicated another.
    seedLegacyV4();
    let corrupted = false;
    await expect(open((sql) => {
      if (!corrupted && sql.includes("except") && sql.includes("from messages)")) {
        corrupted = true;
        database.prepare(`insert into messages_v5
          (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)`)
          .run(MESSAGE_2, CONVERSATION, A, B, "smuggled", 6);
      }
    })).rejects.toThrow(/did not preserve every message/);
    expect(corrupted).toBe(true);
    database = new DatabaseSync(path);
    expect(database.prepare("select count(*) as n from messages").get()).toEqual({ n: 1 });
    expect(database.prepare("select name from sqlite_master where type = 'table' and name = 'messages_v5'").get())
      .toBeUndefined();
  });

  it("retries the v5 rebuild after a failure instead of leaving a half-migrated file", async () => {
    seedLegacyV4();
    const issued: string[] = [];
    await expect(open((sql) => {
      issued.push(sql);
      if (sql === "drop table messages") throw new Error("simulated interruption");
    })).rejects.toThrow(/simulated interruption/);
    // The explicit rollback ran; the file is not merely cleaned up by close().
    expect(issued).toContain("rollback");
    // The adapter closed its handle on failure, so reopen the file to inspect it.
    database = new DatabaseSync(path);
    // The rollback left the old table intact, and a second open migrates it.
    expect(database.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: "Hello there" });
    const history = await open();
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    await history.close();
  });

  it("cascades a conversation delete through its messages on the adapter connection", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    database.exec(`delete from conversations where id = '${CONVERSATION}'`);
    expect(database.prepare("select count(*) as n from messages").get()).toEqual({ n: 0 });
    expect(database.prepare("select count(*) as n from outbox").get()).toEqual({ n: 0 });
    await history.close();
  });

  it("enforces foreign keys, body bounds and outbox lease invariants in SQL", async () => {
    await (await open()).close();
    const raw = new DatabaseSync(path);
    raw.exec("pragma foreign_keys = on");
    expect(() => raw.prepare(
      "insert into messages (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)",
    ).run(MESSAGE, CONVERSATION, A, B, "orphan", 1)).toThrow(/FOREIGN KEY/);
    raw.prepare("insert into conversations (id, created_at, updated_at) values (?,?,?)").run(CONVERSATION, 1, 1);
    expect(() => raw.prepare(
      "insert into messages (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)",
    ).run(MESSAGE, CONVERSATION, A, B, "x".repeat(100_001), 1)).toThrow(/CHECK/);
    raw.prepare("insert into messages (id, conversation_id, author_id, recipient_id, body, created_at) values (?,?,?,?,?,?)")
      .run(MESSAGE, CONVERSATION, A, B, "ok", 1);
    expect(() => raw.prepare("insert into outbox (message_id, status) values (?, 'SENDING')").run(MESSAGE))
      .toThrow(/CHECK/);
    raw.close();
  });

  it("keeps every schema statement idempotent", async () => {
    await (await open()).close();
    database = new DatabaseSync(path);
    for (const statement of MESSAGING_SQLITE_SCHEMA) database.exec(statement);
  });

  it("enforces one authoritative event identity per stored message in SQL", async () => {
    await (await open()).close();
    const raw = new DatabaseSync(path);
    raw.exec("pragma foreign_keys = on");
    raw.prepare("insert into conversations (id, created_at, updated_at) values (?,?,?)").run(CONVERSATION, 1, 1);
    const insert = raw.prepare(
      `insert into messages
        (id, conversation_id, author_id, recipient_id, body, server_event_id, server_sequence, created_at)
       values (?,?,?,?,?,?,?,?)`,
    );
    insert.run(MESSAGE, CONVERSATION, A, B, "one", EVENT, 1, 1);
    expect(() => insert.run(MESSAGE_2, CONVERSATION, A, B, "two", EVENT, 2, 2)).toThrow(/UNIQUE/);
    raw.close();
  });

  it("rejects an invalid lease duration", async () => {
    await expect(openOn(database, { accountId: A, deviceId: DEVICE }, { leaseMs: 0 }))
      .rejects.toThrow(/Invalid messaging lease duration/);
  });

  it("closes the driver instead of leaking it when the identity is invalid", async () => {
    let closed = 0;
    const driver: SqliteDriver = {
      ...driverFor(database),
      close: () => { closed += 1; database.close(); },
    };
    await expect(openSqliteMessagingHistory(driver, { accountId: "not-a-uuid", deviceId: DEVICE }))
      .rejects.toThrow(/Invalid messaging UUID/);
    expect(closed).toBe(1);
  });
});

describe("account/installation binding", () => {
  it("refuses a database file created for another account or installation", async () => {
    await (await open()).close();
    database = new DatabaseSync(path);
    await expect(openOn(database, { accountId: B, deviceId: DEVICE })).rejects.toThrow(/different account/);

    database = new DatabaseSync(path);
    await expect(openOn(database, { accountId: A, deviceId: OTHER_DEVICE })).rejects.toThrow(/different installation/);
  });

  it("binds atomically: a competing initializer cannot overwrite an established identity", async () => {
    const competitorDb = new DatabaseSync(path);
    let attempted = false;
    let competitor: Awaited<ReturnType<typeof openSqliteMessagingHistory>> | null = null;
    let firstError: unknown = null;

    try {
      // The hook runs before this initializer takes its write lock, so a second
      // legitimate initializer completes its own binding first. The loser must fail
      // rather than silently rebind the shared file.
      await open(async (sql) => {
        if (sql !== "begin immediate" || attempted) return;
        attempted = true;
        competitor = await openOn(competitorDb, { accountId: B, deviceId: OTHER_DEVICE });
      });
    } catch (error) {
      firstError = error;
    }

    expect(attempted).toBe(true);
    expect(firstError).toBeInstanceOf(Error);
    expect(competitor).not.toBeNull();
    await competitor!.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare("select value from messaging_meta where key = 'account_id'").get()).toEqual({ value: B });
    raw.close();

    database = new DatabaseSync(path);
    await expect(openOn(database, { accountId: A, deviceId: DEVICE })).rejects.toThrow(/different account/);
  });

  it("lets two initializers with the same identity share the file idempotently", async () => {
    const second = new DatabaseSync(path);
    const first = await open();
    const other = await openOn(second);
    expect(other).toBeDefined();
    await other.close();
    await first.close();
  });
});

describe("durable outgoing text", () => {
  it("stores a message with a queued outbox entry and is idempotent on replay", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    await history.enqueueOutgoing({ ...outgoing });
    expect(await history.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    await history.close();
  });

  it("rejects changed immutable content under the same message id", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "different" })).rejects.toThrow(/Conflicting/);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    await history.close();
  });

  it("rejects an outgoing message for another account", async () => {
    const history = await open();
    await expect(history.enqueueOutgoing({ ...outgoing, authorId: B, recipientId: C }))
      .rejects.toThrow(/Outgoing messaging scope mismatch/);
    expect(await history.listOutbox()).toEqual([]);
    await history.close();
  });

  it("validates identity, body and participants", async () => {
    const history = await open();
    await expect(history.enqueueOutgoing({ ...outgoing, id: "not-a-uuid" })).rejects.toThrow(/UUID/);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "  " })).rejects.toThrow(/text/);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "a\u0000b" })).rejects.toThrow(/text/);
    await expect(history.enqueueOutgoing({ ...outgoing, recipientId: A })).rejects.toThrow(/participants/);
    await history.close();
  });
});

describe("outgoing confirmation", () => {
  it("confirms a QUEUED message from its authoritative echo and clears the outbox", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    const receipt = await history.persistInbound(echoOf());
    expect(receipt).toEqual({ accountId: A, deviceId: DEVICE, mailboxId: MAILBOX, eventId: EVENT });
    expect(await history.getMessage(MESSAGE)).toMatchObject({
      body: "Hello there",
      server: { eventId: EVENT, sequence: 1 },
    });
    expect(await history.listOutbox()).toEqual([]);
    await history.close();
  });

  it("confirms a SENDING message and refuses a late failure afterwards", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    await history.persistInbound(echoOf());
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.failOutgoing(attempt)).toBe(false);
    await history.close();
  });

  it("confirms a FAILED message", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    expect(await history.failOutgoing(attempt)).toBe(true);
    await history.persistInbound(echoOf());
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ server: { eventId: EVENT, sequence: 1 } });
    await history.close();
  });

  it("treats a replayed echo as idempotent", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    await history.persistInbound(echoOf());
    await history.persistInbound(echoOf());
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    expect(rawCount("mailbox_seen")).toBe(1);
    await history.close();
  });

  it("rejects an echo whose body changed and keeps the pending message queued", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    await expect(history.persistInbound(echoOf({ ...outgoing, body: "tampered" })))
      .rejects.toThrow(/Immutable message conflict/);
    expect(await history.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    expect((await history.getMessage(MESSAGE))?.server).toBeUndefined();
    await history.close();
  });
});

describe("leases and failures", () => {
  it("leases one attempt at a time and re-claims only after expiry", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);

    const first = await history.claimNextOutgoing();
    expect(first).toMatchObject({ token: `token-${clock}`, attempt: 1, message: { id: MESSAGE } });
    expect(await history.claimNextOutgoing()).toBeNull();

    clock += 59_999;
    expect(await history.claimNextOutgoing()).toBeNull();

    clock += 1;
    const second = await history.claimNextOutgoing();
    expect(second).toMatchObject({ attempt: 2, message: { id: MESSAGE } });
    await history.close();
  });

  it("fences a stale failure by attempt generation even when the token repeats", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    const first = await history.claimNextOutgoing();
    if (!first) throw new Error("claim failed");
    expect(await history.failOutgoing(first)).toBe(true);

    // Same clock and a deliberately repeating token factory.
    const second = await history.claimNextOutgoing();
    if (!second) throw new Error("second claim failed");
    expect(second.attempt).toBe(2);
    expect(second.token).toBe(first.token);

    expect(await history.failOutgoing(first)).toBe(false);
    expect(await history.failOutgoing({ ...second, token: "not-the-lease-token" })).toBe(false);
    expect(await history.listOutbox()).toEqual([
      { messageId: MESSAGE, status: "SENDING", attempts: 2, token: second.token, leaseUntil: clock + 60_000 },
    ]);
    expect(await history.failOutgoing(second)).toBe(true);
    await history.close();
  });

  it("rejects a failure attempt with mismatched message identity or generation", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    await expect(history.failOutgoing({ ...attempt, message: { ...attempt.message, body: "changed" } }))
      .rejects.toThrow(/identity conflict/);
    await expect(history.failOutgoing({ ...attempt, attempt: 0 })).rejects.toThrow(/generation/);
    expect(await history.listOutbox()).toHaveLength(1);
    await history.close();
  });
});

describe("inbound identity, scope and atomicity", () => {
  it("persists message, event identity and mailbox identity in one transaction", async () => {
    const history = await open();
    const receipt = await history.persistInbound(inbound());
    expect(receipt).toEqual({ accountId: A, deviceId: DEVICE, mailboxId: MAILBOX, eventId: EVENT });
    expect(await history.getMessage(MESSAGE)).toMatchObject({
      body: "Reply text",
      server: { eventId: EVENT, sequence: 1 },
    });
    await history.close();
  });

  it("rejects an inbound message this account does not participate in", async () => {
    const history = await open();
    await expect(history.persistInbound(inbound({ authorId: B, recipientId: C })))
      .rejects.toThrow(/Inbound participant scope mismatch/);
    expect(await history.listMessages(CONVERSATION)).toEqual([]);
    await history.close();
  });

  it("rejects an envelope outside this installation scope", async () => {
    const history = await open();
    await expect(history.persistInbound({ ...inbound(), deviceId: OTHER_DEVICE }))
      .rejects.toThrow(/scope/);
    await expect(history.persistInbound({ ...inbound(), accountId: B }))
      .rejects.toThrow(/scope/);
    await history.close();
  });

  it("rejects one event identity mapped to two messages", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT, MAILBOX_2, 2)))
      .rejects.toThrow(/Immutable event identity conflict/);
    expect(rawCount("messages")).toBe(1);
    await history.close();
  });

  it("rejects mailbox reuse for a different message or sequence", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX, 2)))
      .rejects.toThrow(/Immutable mailbox identity conflict/);
    await expect(history.persistInbound(inbound({}, EVENT, MAILBOX, 9)))
      .rejects.toThrow(/Immutable mailbox identity conflict/);
    await history.close();
  });

  it("rejects a changed conversation for the same message identity without moving a cursor", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(
      inbound({ conversationId: OTHER_CONVERSATION }, EVENT, MAILBOX, 1),
    )).rejects.toThrow(/Immutable/);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("select count(*) as n from conversations where id = ?").get(OTHER_CONVERSATION))
      .toEqual({ n: 0 });
    raw.close();
    await history.close();
  });

  it("rejects duplicate authoritative sequence without partial state", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 1)))
      .rejects.toThrow(/UNIQUE|Immutable/);
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    await history.close();
  });

  it("orders by authoritative sequence, not arrival order", async () => {
    const history = await open();
    await history.persistInbound(inbound({ id: MESSAGE_2, body: "second" }, EVENT_2, MAILBOX_2, 2));
    await history.persistInbound(inbound({ id: MESSAGE, body: "first" }, EVENT, MAILBOX, 1));
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["first", "second"]);
    await history.close();
  });

  it("sees nothing on another connection before COMMIT", async () => {
    let armed = false;
    let beforeCommit = -1;
    const history = await open((sql) => {
      if (!armed || sql !== "commit" || beforeCommit !== -1) return;
      beforeCommit = rawCount("messages");
    });
    armed = true;
    await history.persistInbound(inbound());
    expect(beforeCommit).toBe(0);
    expect(rawCount("messages")).toBe(1);
    await history.close();
  });

  it("rolls back a mid-transaction failure and never acknowledges it", async () => {
    let armed = false;
    let acked = false;
    const history = await open((sql) => {
      if (armed && sql.includes("insert into mailbox_seen")) throw new Error("injected failure");
    });
    armed = true;
    await expect(history.persistInboundAndAck(inbound(), async () => { acked = true; }))
      .rejects.toThrow(/injected failure/);
    expect(acked).toBe(false);
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("mailbox_seen")).toBe(0);
    expect(rawCount("conversations")).toBe(0);
    await history.close();
  });

  it("invokes ACK only after the commit is visible to another connection", async () => {
    const history = await open();
    const seen: string[] = [];
    await history.persistInboundAndAck(inbound(), async (receipt) => {
      seen.push(receipt.eventId);
      const reader = new DatabaseSync(path);
      expect(reader.prepare("select count(*) as n from messages").get()).toEqual({ n: 1 });
      expect(reader.prepare("select count(*) as n from mailbox_seen").get()).toEqual({ n: 1 });
      reader.close();
    });
    expect(seen).toEqual([EVENT]);

    await history.close();
    await expect(history.persistInboundAndAck(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2), async () => {
      throw new Error("must not ACK after close");
    })).rejects.toThrow(/closed/);
  });
});

describe("tombstones", () => {
  it("keeps an unsent message as a tombstone and never resurrects its body", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A, unsentAt: clock, unsentBy: B });
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });

    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    await history.close();
  });

  it("stores a message that arrives after its unsend as a body-less tombstone", async () => {
    const history = await open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A, unsentAt: clock, unsentBy: B });
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });
    await history.close();
  });

  it("does not resurrect or queue an unsent outgoing message", async () => {
    const history = await open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: B, unsentAt: clock, unsentBy: A });
    await history.enqueueOutgoing(outgoing);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    await history.close();
  });

  it("stops leasing a message that is unsent while pending", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: B, unsentAt: clock, unsentBy: A });
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    await history.close();
  });

  it("rejects an unsend that contradicts the stored author or conversation", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, recipientId: B, unsentAt: clock, unsentBy: A,
    })).rejects.toThrow(/Unsend author conflict/);
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: OTHER_CONVERSATION, recipientId: A, unsentAt: clock, unsentBy: B,
    })).rejects.toThrow(/Unsend conversation conflict/);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Reply text" });
    await history.close();
  });

  it("binds a tombstone to its recipient so it cannot erase an unrelated message id", async () => {
    const history = await open();
    await history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, recipientId: C, unsentAt: clock, unsentBy: B,
    });
    // Same id, conversation and author, different recipient: must not match.
    await expect(history.persistInbound(inbound())).rejects.toThrow(/Unsend identity conflict/);
    expect(rawCount("messages")).toBe(0);
    await history.close();
  });

  it("binds an unbound legacy tombstone on the inbound path so it stops being a wildcard", async () => {
    database.exec("create table messaging_meta (key text primary key, value text not null)");
    const bind = database.prepare("insert into messaging_meta (key, value) values (?, ?)");
    bind.run("account_id", A);
    bind.run("device_id", DEVICE);
    bind.run("schema_version", "3");
    database.exec(`create table tombstones (
      message_id text primary key, conversation_id text not null,
      unsent_at integer not null, unsent_by text not null)`);
    database.prepare("insert into tombstones (message_id, conversation_id, unsent_at, unsent_by) values (?,?,?,?)")
      .run(MESSAGE, CONVERSATION, clock, B);
    database = new DatabaseSync(path);

    const history = await open();
    // The reviewer's counterexample: before the fix this NULL matched any
    // recipient and was never repaired on this path.
    await history.persistInbound(inbound());
    expect(database.prepare("select recipient_id as recipientId from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ recipientId: A });
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });

    // Bound now, so a contradicting recipient can no longer be silently accepted.
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, recipientId: C, unsentAt: clock, unsentBy: B,
    })).rejects.toThrow(/Unsend (identity|recipient) conflict/);
    await history.close();
  });

  it("leaves an unbound legacy tombstone unbound after a contradiction, then binds on a later match", async () => {
    database.exec("create table messaging_meta (key text primary key, value text not null)");
    const bind = database.prepare("insert into messaging_meta (key, value) values (?, ?)");
    bind.run("account_id", A);
    bind.run("device_id", DEVICE);
    bind.run("schema_version", "3");
    database.exec(`create table tombstones (
      message_id text primary key, conversation_id text not null,
      unsent_at integer not null, unsent_by text not null)`);
    database.prepare("insert into tombstones (message_id, conversation_id, unsent_at, unsent_by) values (?,?,?,?)")
      .run(MESSAGE, CONVERSATION, clock, B);
    database = new DatabaseSync(path);

    const history = await open();
    // An envelope from a different author contradicts the tombstone. A valid
    // two-party envelope cannot carry a foreign recipient, so author is the
    // reachable contradiction here.
    await expect(history.persistInbound(inbound({ authorId: A, recipientId: B })))
      .rejects.toThrow(/Unsend identity conflict/);
    // The whole transaction rolled back: still unbound, nothing written.
    expect(database.prepare("select recipient_id as recipientId from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ recipientId: null });
    expect(database.prepare("select count(*) as n from mailbox_seen").get()).toEqual({ n: 0 });
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("conversations")).toBe(0);

    // The matching envelope still binds and suppresses, so the rollback did not
    // leave the row permanently unusable.
    await history.persistInbound(inbound());
    expect(database.prepare("select recipient_id as recipientId from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ recipientId: A });
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    await history.close();
  });

  it("refuses to suppress a message whose recipient contradicts a bound tombstone", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    // A poisoned v4 row: same message, conversation and author, wrong recipient.
    database.exec(`insert into tombstones (message_id, conversation_id, recipient_id, unsent_at, unsent_by)
      values ('${MESSAGE}', '${CONVERSATION}', '${C}', ${clock}, '${B}')`);

    await expect(history.persistInbound(inbound({ id: MESSAGE }, EVENT_2, MAILBOX_2, 2)))
      .rejects.toThrow(/Unsend identity conflict/);
    // Nothing was written for the rejected envelope, and the body survived.
    expect(database.prepare("select count(*) as n from mailbox_seen where event_id = ?").get(EVENT_2))
      .toEqual({ n: 0 });
    expect(database.prepare("select body from messages where id = ?").get(MESSAGE))
      .toEqual({ body: "Reply text" });
    await history.close();
  });

  it("rejects an unsend whose recipient contradicts the stored message", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, recipientId: C, unsentAt: clock, unsentBy: B,
    })).rejects.toThrow(/Unsend recipient conflict/);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Reply text" });
    await history.close();
  });

  it("rejects an inbound message whose author contradicts its tombstone", async () => {
    const history = await open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: B, unsentAt: clock, unsentBy: A });
    await expect(history.persistInbound(inbound())).rejects.toThrow(/Unsend identity conflict/);
    await history.close();
  });
});

describe("personal deletion and clear", () => {
  it("retains a delete-for-me marker that arrives before the content", async () => {
    const history = await open();
    await history.deleteForMe(MESSAGE);
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(await history.listMessages(CONVERSATION)).toEqual([]);
    expect(rawCount("messages")).toBe(1);
    await history.close();
  });

  it("deletes for this device only and keeps the row for the other participant's copy", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.deleteForMe(MESSAGE);
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(await history.listMessages(CONVERSATION)).toEqual([]);

    await (await open()).close();
    expect(rawCount("messages")).toBe(1);
  });

  it("cancels a pending send and erases its plaintext when deleted for me", async () => {
    const history = await open();
    await history.enqueueOutgoing(outgoing);
    expect(await history.listOutbox()).toHaveLength(1);

    await history.deleteForMe(MESSAGE);
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    expect(await history.getMessage(MESSAGE)).toBeNull();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: null });
    raw.close();
    await history.close();
  });

  it("erases local plaintext for a delivered message deleted for me", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.deleteForMe(MESSAGE);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: null });
    raw.close();
    expect(await history.getMessage(MESSAGE)).toBeNull();
    await history.close();
  });

  it("does not resurrect content or the conversation shell when a recorded envelope is replayed after a conversation delete", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    database.exec(`delete from conversations where id = '${CONVERSATION}'`);
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("conversations")).toBe(0);

    await history.persistInbound(inbound());
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("conversations")).toBe(0);
    expect(await history.getMessage(MESSAGE)).toBeNull();
    await history.close();
  });

  it("applies clear-through consistently to list and direct reads", async () => {
    const history = await open();
    await history.persistInbound(inbound({ id: MESSAGE, body: "old" }, EVENT, MAILBOX, 1));
    await history.persistInbound(inbound({ id: MESSAGE_2, body: "new" }, EVENT_2, MAILBOX_2, 2));
    await history.enqueueOutgoing({ ...outgoing, id: "00000000-0000-4000-8000-00000000000e", body: "pending" });

    await history.clearThrough(CONVERSATION, 1);
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["new", "pending"]);
    // Clear is local erasure, not only a visibility filter: the covered body
    // must not stay readable in the file.
    expect(rawBodies()).toEqual(["<null>", "new", "pending"]);

    await history.clearThrough(CONVERSATION, 2);
    expect(await history.getMessage(MESSAGE_2)).toBeNull();
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["pending"]);
    await history.close();
  });
});

describe("session lifecycle", () => {
  it("closes the driver and refuses further work", async () => {
    const history = await open();
    await history.close();
    await expect(history.enqueueOutgoing(outgoing)).rejects.toThrow(/closed/);
    await expect(history.listMessages(CONVERSATION)).rejects.toThrow(/closed/);
    expect(() => database.prepare("select 1").get()).toThrow();
  });
});

const STATE = "00000000-0000-4000-8000-0000000000f1";
const STATE_2 = "00000000-0000-4000-8000-0000000000f2";
const STATE_3 = "00000000-0000-4000-8000-0000000000f3";
const STATE_4 = "00000000-0000-4000-8000-0000000000f4";

function state(change: StateChangeEnvelope["change"]): StateChangeEnvelope {
  return { accountId: A, deviceId: DEVICE, change };
}

describe("server-authoritative erasure state", () => {
  it("applies an unsend that follows the authoritative echo", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.applyStateChange(state({
      kind: "UNSEND", eventId: STATE, sequence: 1, conversationId: CONVERSATION, occurredAt: clock + 1,
      messageId: MESSAGE, authorId: B, recipientId: A, messageSequence: 1,
    }));
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock + 1 });
    await history.close();
  });

  it("applies delete-for-me after the echo and erases the local body", async () => {
    const history = await open();
    await history.persistInbound(inbound());
    await history.applyStateChange(state({
      kind: "DELETE_FOR_ME", eventId: STATE_2, sequence: 1, conversationId: CONVERSATION, occurredAt: clock + 1,
      messageId: MESSAGE, authorId: B, recipientId: A, messageSequence: 1,
    }));
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(database.prepare("select body, server_event_id as eventId from messages where id = ?").get(MESSAGE))
      .toEqual({ body: null, eventId: EVENT });
    await history.close();
  });

  it("does not block the authoritative echo when the state change arrived first", async () => {
    const history = await open();
    await history.applyStateChange(state({
      kind: "DELETE_FOR_ME", eventId: STATE_3, sequence: 1, conversationId: CONVERSATION, occurredAt: clock + 1,
      messageId: MESSAGE, authorId: B, recipientId: A, messageSequence: 1,
    }));
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(database.prepare("select body, server_event_id as eventId from messages where id = ?").get(MESSAGE))
      .toEqual({ body: null, eventId: EVENT });
    await history.close();
  });

  it("applies clear-for-me through a sequence and erases only the covered bodies", async () => {
    const history = await open();
    await history.persistInbound(inbound({ id: MESSAGE, body: "old" }, EVENT, MAILBOX, 1));
    await history.persistInbound(inbound({ id: MESSAGE_2, body: "new" }, EVENT_2, MAILBOX_2, 2));
    await history.applyStateChange(state({
      kind: "CLEAR_FOR_ME", eventId: STATE_4, sequence: 1, conversationId: CONVERSATION,
      occurredAt: clock + 1, peerId: B, throughSequence: 1,
    }));
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect((await history.listMessages(CONVERSATION)).map((message) => message.body)).toEqual(["new"]);
    expect(database.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: null });
    await history.close();
  });
});

const ATTACHMENT = "00000000-0000-4000-8000-000000000020";
const ATTACHMENT_2 = "00000000-0000-4000-8000-000000000021";
const ATTACHMENT_3 = "00000000-0000-4000-8000-000000000022";
const ORPHAN_ATTACHMENT = "00000000-0000-4000-8000-000000000024";
const MESSAGE_3 = "00000000-0000-4000-8000-000000000025";
const EVENT_3 = "00000000-0000-4000-8000-000000000027";
const MAILBOX_3 = "00000000-0000-4000-8000-000000000028";

const MEDIA_COLUMNS = `id, message_id as messageId, direction, sha256, mime,
  byte_size as byteSize, width, height, expires_at as expiresAt,
  last_access_at as lastAccessAt, state, attempts, token, lease_until as leaseUntil`;

function rawMedia(id: string): Record<string, unknown> | undefined {
  const reader = new DatabaseSync(path);
  try {
    return reader.prepare(`select ${MEDIA_COLUMNS} from media_attachments where id = ?`).get(id) as
      Record<string, unknown> | undefined;
  } finally {
    reader.close();
  }
}

async function openWithMedia(port: FakeMediaBytes, beforeExec?: (sql: string) => void | Promise<void>) {
  const history = await openOn(database, { accountId: A, deviceId: DEVICE }, {
    mediaBytes: port, decodeMedia: async () => undefined,
    token: () => ATTACHMENT_3,
  }, beforeExec);
  await history.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "CONNECTED", request: "NONE",
    requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 });
  return history;
}

const MEDIA_DDL_PREFIXES = [
  "create table if not exists media_attachments (",
  "create unique index if not exists ux_media_attachments_message",
];

/**
 * A v5 file: every table except `media_attachments`, the v5 body CHECK, one
 * accepted message and its pending outbox row. This is what the previous build
 * actually wrote, so opening it is a real forward migration.
 */
function seedV5() {
  database.exec("create table messaging_meta (key text primary key, value text not null)");
  const bind = database.prepare("insert into messaging_meta (key, value) values (?, ?)");
  bind.run("account_id", A);
  bind.run("device_id", DEVICE);
  bind.run("schema_version", "5");
  for (const statement of MESSAGING_SQLITE_SCHEMA as readonly string[]) {
    if (MEDIA_DDL_PREFIXES.some((prefix) => statement.startsWith(prefix))) continue;
    database.exec(statement);
  }
  database.prepare("insert into conversations (id, created_at, updated_at) values (?,?,?)")
    .run(CONVERSATION, 1, 1);
  database.prepare(`insert into messages
    (id, conversation_id, author_id, recipient_id, body, server_event_id, server_sequence, created_at)
    values (?,?,?,?,?,?,?,?)`).run(MESSAGE, CONVERSATION, A, B, "", EVENT, 1, 5);
  database.prepare("insert into outbox (message_id, status) values (?, 'QUEUED')").run(MESSAGE);
}

describe("chat media schema and migration", () => {
  it("migrates a v5 file additively, preserving every row and the v5 body CHECK", async () => {
    seedV5();
    const history = await openWithMedia(new FakeMediaBytes(() => clock));
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    // No rebuild: the image-only body and the pending send are untouched.
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", server: { sequence: 1 } });
    expect((await history.listOutbox()).map((entry) => entry.messageId)).toEqual([MESSAGE]);
    expect(database.prepare("select name from sqlite_master where type = 'table' and name = 'media_attachments'").get())
      .toEqual({ name: "media_attachments" });
    await history.close();
  });

  it("produces byte-identical media_attachments SQL in a fresh v6 file and a migrated v5 file", async () => {
    const freshPath = join(dir, "fresh.db");
    const freshDatabase = new DatabaseSync(freshPath);
    const fresh = await openOn(freshDatabase, { accountId: A, deviceId: DEVICE });
    await fresh.close();
    const readSchema = (file: string) => {
      const reader = new DatabaseSync(file);
      try {
        return reader.prepare(`select type, name, sql from sqlite_master
          where tbl_name = 'media_attachments' and sql is not null order by type, name`).all();
      } finally {
        reader.close();
      }
    };
    const freshSchema = readSchema(freshPath);

    seedV5();
    const migrated = await openWithMedia(new FakeMediaBytes(() => clock));
    await migrated.close();
    const migratedSchema = readSchema(path);

    expect(migratedSchema).toEqual(freshSchema);
    expect(freshSchema).toHaveLength(2); // the table and its message-id index
    expect((freshSchema as Array<{ sql: string }>).every((row) => typeof row.sql === "string")).toBe(true);
  });

  it("enforces every media record invariant in SQL", async () => {
    await (await open()).close(); // Schema only; no cached conversation fixture.
    const raw = new DatabaseSync(path);
    raw.exec("pragma foreign_keys = on");
    const insert = (overrides: Record<string, unknown> = {}) => {
      const row = {
        id: ATTACHMENT, messageId: MESSAGE, direction: "OUT",
        sha256: "a".repeat(64), mime: "image/png", byteSize: 64, width: 32, height: 32,
        expiresAt: null, lastAccessAt: 0, state: "QUEUED", attempts: 0, token: null, leaseUntil: null,
        ...overrides,
      };
      raw.prepare(`insert into media_attachments
        (id, message_id, direction, sha256, mime, byte_size, width, height, expires_at,
          last_access_at, state, attempts, token, lease_until)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        row.id as string, row.messageId as string, row.direction as string, row.sha256 as string,
        row.mime as string, row.byteSize as number, row.width as number, row.height as number,
        row.expiresAt as number | null, row.lastAccessAt as number, row.state as string,
        row.attempts as number, row.token as string | null, row.leaseUntil as number | null,
      );
    };

    // Parent must exist: the row is a claim about a message, not a free record.
    expect(() => insert()).toThrow(/FOREIGN KEY/);
    raw.prepare("insert into conversations (id, created_at, updated_at) values (?,?,?)").run(CONVERSATION, 1, 1);
    raw.prepare(`insert into messages (id, conversation_id, author_id, recipient_id, body, created_at)
      values (?,?,?,?,?,?)`).run(MESSAGE, CONVERSATION, A, B, "", 1);
    insert();
    expect(raw.prepare("select count(*) as n from media_attachments").get()).toEqual({ n: 1 });

    const violations: Array<[string, Record<string, unknown>]> = [
      ["uppercase digest", { sha256: "A".repeat(64) }],
      ["non-hex digest", { sha256: "g".repeat(64) }],
      ["short digest", { sha256: "a".repeat(63) }],
      ["unsupported mime", { mime: "image/gif" }],
      ["zero byte size", { byteSize: 0 }],
      ["oversized byte size", { byteSize: 20 * 1024 * 1024 + 1 }],
      ["zero width", { width: 0 }],
      ["oversized height", { height: 8193 }],
      ["zero expiry", { expiresAt: 0 }],
      ["negative access", { lastAccessAt: -1 }],
      ["unknown state", { state: "SENDING" }],
      ["negative attempts", { attempts: -1 }],
      ["inbound queued", { direction: "IN", state: "QUEUED" }],
      ["lease without uploading", { token: ATTACHMENT, leaseUntil: 5 }],
      ["uploading without token", { state: "UPLOADING" }],
      ["uploading without lease", { state: "UPLOADING", token: ATTACHMENT }],
      ["malformed token", { state: "UPLOADING", token: "not-a-uuid", leaseUntil: 5 }],
      ["single token", { token: ATTACHMENT }],
      ["single lease", { leaseUntil: 5 }],
      ["fractional size", { byteSize: 1.5 }],
      ["fractional width", { width: 1.5 }],
      ["fractional height", { height: 1.5 }],
      ["fractional access", { lastAccessAt: 1.5 }],
      ["fractional attempt", { attempts: 1.5 }],
      ["inbound no expiry", { direction: "IN", state: "READY" }],
      ["malformed id", { id: "not-a-uuid" }],
      ["non UUID token", { state: "UPLOADING", token: "a".repeat(36), leaseUntil: 5 }],
    ];
    for (const [label, overrides] of violations) {
      expect(() => insert({ id: ATTACHMENT_2, messageId: MESSAGE, ...overrides }), label).toThrow(/CHECK/);
    }
    // One attachment per message for this wave.
    expect(() => insert({ id: ATTACHMENT_2 })).toThrow(/UNIQUE/);
    // Inbound may be awaiting ACK, ready or evicted.
    raw.prepare("delete from media_attachments").run();
    insert({ id: ATTACHMENT_2, direction: "IN", state: "AWAITING_ACK", expiresAt: 5 });
    raw.prepare("delete from media_attachments").run();
    insert({ id: ATTACHMENT_3, messageId: MESSAGE, direction: "IN", state: "READY", expiresAt: 5 });
    raw.close();
  });

  it("cascades a message delete through its attachment row", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, metadata, bytes);
    expect(rawCount("media_attachments")).toBe(1);
    database.exec(`delete from messages where id = '${MESSAGE}'`);
    expect(rawCount("media_attachments")).toBe(0);
    await history.close();
  });
});

describe("chat media records", () => {
  it.each(["purge", "delete"])("does not dispatch ACK when %s wins after commit but before ACK admission", async (action) => {
    const port = new FakeMediaBytes(() => clock);
    const one = await openWithMedia(port);
    const two = await openOn(new DatabaseSync(path), { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => undefined,
    });
    try {
      await one.persistInbound(inbound());
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
      afterNextHistoryOperation(() => action === "purge" ? two.clearMedia() : two.removeMediaForMessage(MESSAGE));
      const ack = vi.fn(async () => undefined);
      await expect(one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack))
        .rejects.toThrow(/purged|not available|unavailable/i);
      expect(ack).not.toHaveBeenCalled();
      expect(rawCount("media_attachments")).toBe(0);
      expect(await port.keys(A)).toEqual([]);
    } finally { await one.close(); await two.close(); }
  });

  it("close drains a delayed ACK-admission read and prevents callback dispatch", async () => {
    const port = new FakeMediaBytes(() => clock);
    const base = driverFor(database);
    const entered = deferred(), release = deferred();
    let armAfterCommit = false, delayParent = false, nativeClosed = false;
    const history = await openSqliteMessagingHistory({ ...base,
      exec: async (sql) => {
        await base.exec(sql);
        if (sql === "commit" && armAfterCommit) { delayParent = true; armAfterCommit = false; }
      },
      all: async <T>(sql: string, params?: readonly (string | number | null)[]) => {
        const result = await base.all<T>(sql, params);
        if (sql === S.getMediaParent && delayParent) {
          delayParent = false; entered.resolve(); await release.promise;
        }
        return result;
      },
      close: async () => { nativeClosed = true; await base.close(); },
    }, { accountId: A, deviceId: DEVICE }, { mediaBytes: port, decodeMedia: async () => undefined, now: () => clock });
    await history.persistInbound(inbound());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
    armAfterCommit = true;
    const ack = vi.fn(async () => undefined);
    const settled = Promise.allSettled([history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)]);
    await entered.promise;
    const closing = history.close();
    try { await Promise.resolve(); expect(nativeClosed).toBe(false); }
    finally { release.resolve(); await settled; await closing; }
    expect((await settled)[0]).toMatchObject({ status: "rejected" });
    expect(ack).not.toHaveBeenCalled();
    expect(await port.has(A, ATTACHMENT)).toBe(true);
  });

  it.each([false, true])("invalidates an unknown transaction outcome without exposing uncommitted rows or holding the writer lock (owner closing: %s)", async (closeDuringCommit) => {
    const port = new FakeMediaBytes(() => clock);
    const base = driverFor(database);
    let failCompletion = false, driverClosed = false, closeCount = 0;
    let ownerClose: void | Promise<void>;
    const history = await openSqliteMessagingHistory({ ...base,
      exec: async (sql) => {
        if (failCompletion && (sql === "commit" || sql === "rollback")) {
          if (sql === "commit" && closeDuringCommit) ownerClose = history.close();
          throw new Error(`synthetic ${sql} not dispatched`);
        }
        await base.exec(sql);
      },
      close: async () => { closeCount++; await base.close(); driverClosed = true; },
    }, { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => undefined, now: () => clock,
    });
    try {
      await history.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "CONNECTED", request: "NONE",
        requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 });
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
      failCompletion = true;
      await expect(history.enqueueOutgoingWithMedia(outgoing, fixture.metadata, fixture.bytes))
        .rejects.toThrow(/commit not dispatched/);
      expect(rawCount("messages")).toBe(0); // independent reader sees no commit
      const reads = await Promise.allSettled([
        history.getMessage(MESSAGE), history.listMessages(CONVERSATION), history.listMedia(CONVERSATION),
        history.claimNextMediaUpload(),
      ]);
      expect(reads.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
      expect(driverClosed).toBe(true);
      expect(await port.get(A, ATTACHMENT)).toEqual(fixture.bytes); // unknown outcome retains bytes

      const fresh = new DatabaseSync(path);
      fresh.exec("begin immediate; rollback"); // no leaked writer lock, before explicit owner close
      const reopened = await openOn(fresh, { accountId: A, deviceId: DEVICE }, {
        mediaBytes: port, decodeMedia: async () => undefined,
      });
      try {
        expect(await reopened.getMessage(MESSAGE)).toBeNull();
        expect(await reopened.listMedia(CONVERSATION)).toEqual([]);
        expect(await reopened.claimNextMediaUpload()).toBeNull();
        clock += MEDIA_SWEEP_GRACE_MS + 1;
        expect(await reopened.sweepOrphanMedia(10)).toBe(1);
        expect(await port.keys(A)).toEqual([]);
      } finally { await reopened.close(); }
    } finally { await history.close(); await ownerClose!; }
    expect(closeCount).toBe(1);
  });

  it.each(["before", "after"] as const)("recovers a BEGIN failure %s SQL execution without admission or a leaked writer lock", async (failureAt) => {
    const port = new FakeMediaBytes(() => clock);
    const base = driverFor(database);
    let failBegin = false, driverClosed = false;
    const history = await openSqliteMessagingHistory({ ...base,
      exec: async (sql) => {
        if (sql === "begin immediate" && failBegin) {
          failBegin = false;
          if (failureAt === "after") await base.exec(sql);
          throw new Error("synthetic BEGIN failed reply");
        }
        await base.exec(sql);
      },
      close: async () => { await base.close(); driverClosed = true; },
    }, { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => undefined, now: () => clock,
    });
    try {
      await history.persistInbound(inbound());
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
      const ack = vi.fn(async () => undefined);
      failBegin = true;
      await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack))
        .rejects.toThrow(/BEGIN failed reply/);
      expect(ack).not.toHaveBeenCalled();
      expect(await port.keys(A)).toEqual([]);
      expect(rawCount("messages")).toBe(1); // only the previously committed parent
      expect(rawCount("media_attachments")).toBe(0);
      expect(rawCount("outbox")).toBe(0);
      const fresh = new DatabaseSync(path);
      try { fresh.exec("begin immediate; rollback"); }
      finally { fresh.close(); }
      if (failureAt === "before") {
        expect(driverClosed).toBe(true); // rollback cannot acknowledge a nonexistent transaction
        await expect(history.getMessage(MESSAGE)).rejects.toThrow(/closed/);
      } else {
        expect(driverClosed).toBe(false); // acknowledged rollback permits safe reuse
        expect(await history.claimNextMediaUpload()).toBeNull();
      }
      const reopened = await openOn(new DatabaseSync(path), { accountId: A, deviceId: DEVICE }, {
        mediaBytes: port, decodeMedia: async () => undefined,
      });
      try {
        await reopened.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack);
        expect(ack).toHaveBeenCalledOnce();
        expect(await reopened.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
      } finally { await reopened.close(); }
    } finally { await history.close(); }
  });

  it.each(["throw", "reject"] as const)("keeps unknown-outcome invalidation when driver close fails by %s", async (failureMode) => {
    const port = new FakeMediaBytes(() => clock);
    const base = driverFor(database);
    let armed = false, closeCount = 0;
    let ownerCloseResult: Promise<PromiseSettledResult<void>[]> | undefined;
    const originalError = new Error("synthetic COMMIT unavailable");
    const closeError = new Error("synthetic native close unavailable");
    const history = await openSqliteMessagingHistory({ ...base,
      exec: async (sql) => {
        if (armed && (sql === "commit" || sql === "rollback")) {
          if (sql === "commit") ownerCloseResult = Promise.allSettled([Promise.resolve(history.close())]);
          throw originalError;
        }
        await base.exec(sql);
      },
      close: () => {
        closeCount++;
        if (failureMode === "throw") throw closeError;
        return Promise.reject(closeError);
      },
    }, { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => undefined, now: () => clock,
    });
    try {
      await history.persistInbound(inbound());
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
      const ack = vi.fn(async () => undefined);
      armed = true;
      await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)).rejects.toBe(originalError);
      expect(ack).not.toHaveBeenCalled();
      await expect(history.getMessage(MESSAGE)).rejects.toThrow(/closed/);
      await expect(history.close()).rejects.toBe(closeError);
      expect(await ownerCloseResult).toEqual([{ status: "rejected", reason: closeError }]);
      expect(closeCount).toBe(1);
      expect(await port.get(A, ATTACHMENT)).toEqual(fixture.bytes);
    } finally { await base.close(); } // test-owned driver failure cannot release its actual DB
  });

  it("preserves committed media bytes when the COMMIT response is lost", async () => {
    const port = new FakeMediaBytes(() => clock);
    const base = driverFor(database);
    let loseCommitResponse = false;
    const history = await openSqliteMessagingHistory({ ...base, exec: async (sql) => {
      await base.exec(sql); // Real file-backed commit happens first.
      if (sql === "commit" && loseCommitResponse) {
        loseCommitResponse = false; throw new Error("commit response lost");
      }
    } }, { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => undefined, now: () => clock,
    });
    try {
      await history.persistInbound(inbound());
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
      loseCommitResponse = true;
      const ack = vi.fn(async () => undefined);
      await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack))
        .rejects.toThrow(/commit response lost/);
      expect(ack).not.toHaveBeenCalled();
      expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "AWAITING_ACK" });
      expect(await port.get(A, ATTACHMENT)).toEqual(fixture.bytes);
      await expect(history.getMessage(MESSAGE)).rejects.toThrow(/closed/);
      const reopened = await openOn(new DatabaseSync(path), { accountId: A, deviceId: DEVICE }, {
        mediaBytes: port, decodeMedia: async () => undefined,
      });
      try {
        await reopened.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack);
        expect(ack).toHaveBeenCalledOnce();
        expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "READY" });
        expect(await reopened.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
      } finally { await reopened.close(); }
    } finally { await history.close(); }
  });

  it("refuses REQUEST media admission and stops new claims after End", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    try {
      const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
      await history.enqueueOutgoingWithMedia(outgoing, fixture.metadata, fixture.bytes);
      await history.persistInbound(echoOf());
      await history.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "REQUEST", request: "NONE",
        requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 2 });
      expect(await history.claimNextMediaUpload()).toBeNull();
      const second = await mediaFixture(ATTACHMENT_2, MESSAGE_2);
      await expect(history.enqueueOutgoingWithMedia({ ...outgoing, id: MESSAGE_2 }, second.metadata, second.bytes))
        .rejects.toThrow(/media unavailable/i);
      expect(await port.keys(A)).toEqual([ATTACHMENT]);
      expect(await history.getMessage(MESSAGE_2)).toBeNull();
    } finally { await history.close(); }
  });

  it("sweeps aged orphan bytes on open but preserves the crash grace window", async () => {
    const port = new FakeMediaBytes(() => clock);
    port.plant(A, ORPHAN_ATTACHMENT, mediaBytes(), clock - MEDIA_SWEEP_GRACE_MS - 1);
    port.plant(A, ATTACHMENT, mediaBytes(), clock);
    const history = await openWithMedia(port);
    try { expect(await port.keys(A)).toEqual([ATTACHMENT]); }
    finally { await history.close(); }
  });

  it("durably fences reopen after account media purge", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
    await history.clearMedia();
    await history.close();
    database = new DatabaseSync(path);
    const reopened = await openWithMedia(port);
    let acks = 0;
    try {
      await expect(reopened.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => { acks++; }))
        .rejects.toThrow(/purged/);
      expect(acks).toBe(0);
      expect(await port.keys(A)).toEqual([]);
      expect(rawCount("media_attachments")).toBe(0);
      await reopened.clearMedia();
      await reopened.clearMedia();
    } finally { await reopened.close(); }
  });

  it("checks initial image dimensions and fails closed on decoder failure", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openOn(database, { accountId: A, deviceId: DEVICE }, {
      mediaBytes: port, decodeMedia: async () => { throw new Error("decode failed"); },
    });
    await history.persistInbound(inbound());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
    let acks = 0;
    const ack = async () => { acks++; };
    await expect(history.persistVerifiedMediaAndAck(
      { ...fixture.metadata, width: 31 }, fixture.bytes, ack,
    )).rejects.toThrow(/dimension mismatch/i);
    await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack))
      .rejects.toThrow(/decode failed/);
    expect(acks).toBe(0);
    expect(rawCount("media_attachments")).toBe(0);
    expect(await port.keys(A)).toEqual([]);
    await history.close();
  });

  it("does not ACK after close during a committed media transaction", async () => {
    const port = new FakeMediaBytes(() => clock);
    let closeOnCommit = false;
    let closing: Promise<void> | undefined;
    const history = await openWithMedia(port, (sql) => {
      if (sql === "commit" && closeOnCommit) closing = Promise.resolve(history.close());
    });
    await history.persistInbound(inbound());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
    closeOnCommit = true;
    let acks = 0;
    await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => { acks++; }))
      .rejects.toThrow(/closed/);
    await closing;
    expect(acks).toBe(0);
    // COMMIT succeeded despite close: do not delete its now-owned bytes.
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "AWAITING_ACK" });
    expect(await port.has(A, ATTACHMENT)).toBe(true);
  });

  it("erases media on delete, blocks late replay, and keeps other media intact", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1000 });
    await history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => undefined);
    await history.deleteForMe(MESSAGE);
    expect(rawMedia(ATTACHMENT)).toBeUndefined();
    expect(await port.keys(A)).toEqual([]);
    await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => undefined))
      .rejects.toThrow(/parent is not available/);
    await history.close();
  });

  it("stores bytes before the attachment row and never claims before the text echo", async () => {
    const trace: string[] = [];
    const port = new FakeMediaBytes(() => clock, trace);
    const history = await openWithMedia(port, (sql) => {
      if (sql.includes("insert into media_attachments")) trace.push("row");
      if (sql === "commit") trace.push("commit");
    });
    trace.length = 0; // Ignore initialization commits, not admission ordering.
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, metadata, bytes);

    // Bytes, then the row, then its commit: the ordering that makes a row
    // claiming missing bytes impossible.
    expect(trace.indexOf(`bytes:put:${ATTACHMENT}`)).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf(`bytes:put:${ATTACHMENT}`)).toBeLessThan(trace.indexOf("row"));
    expect(trace.indexOf("row")).toBeLessThan(trace.indexOf("commit"));
    // The image-only message exists with no caption, not with a null body.
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    // No claim until the authoritative text echo names the server message.
    expect(await history.claimNextMediaUpload()).toBeNull();
    await history.persistInbound(echoOf({ ...outgoing, body: "" }));
    const attempt = await history.claimNextMediaUpload();
    expect(attempt).toMatchObject({
      attachmentId: ATTACHMENT, messageId: MESSAGE, sha256: metadata.sha256, attempt: 1,
    });
    await history.close();
  });

  it("rolls the byte write back when the attachment row is refused", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port, (sql) => {
      if (sql.includes("insert into media_attachments")) throw new Error("injected failure");
    });
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await expect(history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, metadata, bytes))
      .rejects.toThrow(/injected failure/);
    // Both stores rolled back: no message, no outbox, no row, no bytes.
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("media_attachments")).toBe(0);
    expect(await port.keys(A)).toEqual([]);
    await history.close();
  });

  it("keeps one attachment per message and rolls back the second byte write", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    const first = await mediaFixture(ATTACHMENT, MESSAGE);
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, first.metadata, first.bytes);
    await history.persistInbound(echoOf({ ...outgoing, body: "" }));

    const second = await mediaFixture(ATTACHMENT_2, MESSAGE);
    await expect(history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, second.metadata, second.bytes))
      .rejects.toThrow(/media identity conflict/i);
    expect(rawCount("media_attachments")).toBe(1);
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
    // The replay of the admitted attachment is idempotent.
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, first.metadata, first.bytes);
    expect(await port.keys(A)).toEqual([ATTACHMENT]);
    await history.close();
  });

  it("refuses to claim an attachment whose bytes have gone", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, metadata, bytes);
    await history.persistInbound(echoOf({ ...outgoing, body: "" }));
    await port.delete(A, [ATTACHMENT]);

    await expect(history.claimNextMediaUpload()).rejects.toThrow(/bytes missing/);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "QUEUED", attempts: 0, token: null });
    await history.close();
  });

  it("claims once under concurrency, fences stale tokens and recovers an expired lease", async () => {
    const history = await openWithMedia(new FakeMediaBytes(() => clock));
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE);
    await history.enqueueOutgoingWithMedia({ ...outgoing, body: "" }, metadata, bytes);
    await history.persistInbound(echoOf({ ...outgoing, body: "" }));

    const claimed = await Promise.all([history.claimNextMediaUpload(), history.claimNextMediaUpload()]);
    const attempts = claimed.filter((attempt) => attempt !== null);
    expect(attempts).toHaveLength(1);
    const first = attempts[0]!;
    expect(first.attempt).toBe(1);

    // An expired lease is recovered with a new generation.
    clock += 60_000;
    const second = await history.claimNextMediaUpload();
    expect(second).toMatchObject({ attachmentId: ATTACHMENT, attempt: 2 });
    // The stale generation cannot fail or complete the newer attempt.
    expect(await history.failMediaUpload(first)).toBe(false);
    expect(await history.completeMediaUpload(first)).toBe(false);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "UPLOADING", attempts: 2, token: second!.token });
    expect(await history.completeMediaUpload(second!)).toBe(true);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "AWAITING_ACK", token: null, leaseUntil: null });
    expect(await history.markMediaReady(ATTACHMENT)).toBe(true);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "READY" });
    await history.close();
  });

  it("persists verified inbound bytes, commits before ACK, and keeps them when ACK fails", async () => {
    const trace: string[] = [];
    const port = new FakeMediaBytes(() => clock, trace);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: clock + 1_000_000,
    });

    const acked: string[] = [];
    await history.persistVerifiedMediaAndAck(metadata, bytes, async (record) => {
      acked.push(record.id);
      // The row is already committed and visible to another connection.
      const reader = new DatabaseSync(path);
      try {
        expect(reader.prepare("select state from media_attachments where id = ?").get(ATTACHMENT))
          .toEqual({ state: "AWAITING_ACK" });
      } finally {
        reader.close();
      }
      expect(await port.has(A, ATTACHMENT)).toBe(true);
    });
    expect(acked).toEqual([ATTACHMENT]);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "READY", direction: "IN" });
    expect(await history.readMedia(ATTACHMENT)).not.toBeNull();

    // A second attachment whose ACK fails keeps its bytes and stays replayable.
    await history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2));
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_2, {
      direction: "IN", expiresAt: clock + 1_000_000,
    });
    const failure = new Error("ack unavailable");
    await expect(history.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => {
      throw failure;
    })).rejects.toThrow(/ack unavailable/);
    expect(rawMedia(ATTACHMENT_2)).toMatchObject({ state: "AWAITING_ACK" });
    expect(await port.has(A, ATTACHMENT_2)).toBe(true);
    expect(await history.readMedia(ATTACHMENT_2)).not.toBeNull();

    const replays: string[] = [];
    await history.persistVerifiedMediaAndAck(second.metadata, second.bytes, async (record) => {
      replays.push(record.id);
    });
    expect(replays).toEqual([ATTACHMENT_2]);
    expect(rawMedia(ATTACHMENT_2)).toMatchObject({ state: "READY" });
    await history.close();
  });

  it("rejects a digest, length, MIME or dimension mismatch with no row, no ACK and no render path", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const acked: string[] = [];
    const ack = async (record: { id: string }) => { acked.push(record.id); };

    const base = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    // Wrong digest: valid-looking metadata, different bytes.
    await expect(history.persistVerifiedMediaAndAck(
      { ...base.metadata, sha256: "b".repeat(64) }, base.bytes, ack,
    )).rejects.toThrow(/digest mismatch/i);
    // Wrong declared length, correct digest of the actual bytes.
    await expect(history.persistVerifiedMediaAndAck(
      { ...base.metadata, byteSize: base.bytes.byteLength + 1 }, base.bytes, ack,
    )).rejects.toThrow(/length mismatch/i);
    // MIME that contradicts the bytes.
    const png = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    await expect(history.persistVerifiedMediaAndAck(
      { ...png.metadata, mime: "image/jpeg" }, png.bytes, ack,
    )).rejects.toThrow(/media type mismatch/i);
    expect(acked).toEqual([]);
    expect(rawCount("media_attachments")).toBe(0);
    expect(await port.keys(A)).toEqual([]);
    expect(await history.readMedia(ATTACHMENT)).toBeNull();

    // A committed record cannot be re-described with different dimensions.
    await history.persistVerifiedMediaAndAck(png.metadata, png.bytes, ack);
    await expect(history.persistVerifiedMediaAndAck(
      { ...png.metadata, width: png.metadata.width + 1 }, png.bytes, ack,
    )).rejects.toThrow(/identity conflict/i);
    expect(acked).toEqual([ATTACHMENT]);
    expect(rawMedia(ATTACHMENT)).toMatchObject({ width: 32, height: 32, state: "READY" });
    await history.close();
  });

  it("defers an inbound attachment whose parent is missing or suppressed", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    const missing = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: clock + 1_000_000,
    });
    const acked: string[] = [];
    await expect(history.persistVerifiedMediaAndAck(missing.metadata, missing.bytes, async (record) => {
      acked.push(record.id);
    })).rejects.toThrow(/parent is not available/);
    expect(acked).toEqual([]);
    expect(rawCount("media_attachments")).toBe(0);
    // Nothing was stored: a deferred attachment must not leave orphan bytes.
    expect(await port.keys(A)).toEqual([]);

    // A suppressed parent is not visible, so its attachment is never admitted.
    await history.persistInbound(inbound());
    await history.deleteForMe(MESSAGE);
    await expect(history.persistVerifiedMediaAndAck(missing.metadata, missing.bytes, async (record) => {
      acked.push(record.id);
    })).rejects.toThrow(/parent is not available/);
    expect(acked).toEqual([]);
    expect(rawCount("media_attachments")).toBe(0);
    await history.close();
  });

  it("evicts only READY bytes and keeps the metadata", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    await history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2));
    const ready = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    const pending = await mediaFixture(ATTACHMENT_2, MESSAGE_2, { direction: "IN", expiresAt: clock + 1_000_000 });
    await history.persistVerifiedMediaAndAck(ready.metadata, ready.bytes, async () => undefined);
    await expect(history.persistVerifiedMediaAndAck(pending.metadata, pending.bytes, async () => {
      throw new Error("ack unavailable");
    })).rejects.toThrow(/ack unavailable/);

    // An outbound queued attachment and an uploading one are both protected.
    const queued = await mediaFixture(ATTACHMENT_3, MESSAGE_3);
    await history.enqueueOutgoingWithMedia(
      { ...outgoing, id: MESSAGE_3, body: "" }, queued.metadata, queued.bytes,
    );
    await history.persistInbound(echoOf({ ...outgoing, id: MESSAGE_3, body: "" }, EVENT_3, MAILBOX_3, 3));
    const claimed = await history.claimNextMediaUpload();
    expect(claimed).toMatchObject({ attachmentId: ATTACHMENT_3 });

    expect(await history.evictMedia(10)).toBe(1);
    expect(rawMedia(ATTACHMENT)).toMatchObject({
      state: "EVICTED", sha256: ready.metadata.sha256, mime: "image/png",
      byteSize: ready.metadata.byteSize, width: 32, height: 32,
    });
    expect(await port.has(A, ATTACHMENT)).toBe(false);
    expect(await history.readMedia(ATTACHMENT)).toBeNull();
    // Protected states keep their bytes.
    expect(await port.has(A, ATTACHMENT_2)).toBe(true);
    expect(await port.has(A, ATTACHMENT_3)).toBe(true);
    expect(rawMedia(ATTACHMENT_2)).toMatchObject({ state: "AWAITING_ACK" });
    expect(rawMedia(ATTACHMENT_3)).toMatchObject({ state: "UPLOADING" });
    await history.close();
  });

  it("sweeps orphan bytes and the bytes still held by an EVICTED row", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const ready = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    await history.persistVerifiedMediaAndAck(ready.metadata, ready.bytes, async () => undefined);
    await history.evictMedia(1);

    // Simulate a crash between the EVICTED commit and the byte delete, plus a
    // byte entry that never got a row at all.
    port.plant(A, ATTACHMENT, mediaBytes(), clock - MEDIA_SWEEP_GRACE_MS - 1);
    port.plant(A, ORPHAN_ATTACHMENT, mediaBytes(), clock - MEDIA_SWEEP_GRACE_MS - 1);
    const live = await mediaFixture(ATTACHMENT_2, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    await history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2));
    await history.persistVerifiedMediaAndAck(
      { ...live.metadata, messageId: MESSAGE_2 }, live.bytes, async () => undefined,
    );

    expect(await history.sweepOrphanMedia(10)).toBe(2);
    expect(await port.keys(A)).toEqual([ATTACHMENT_2]);
    // The EVICTED row keeps its metadata; only its bytes are gone.
    expect(rawMedia(ATTACHMENT)).toMatchObject({ state: "EVICTED", sha256: ready.metadata.sha256 });
    await history.close();
  });

  it("clears every attachment row and byte entry for account deletion", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    const { bytes, metadata } = await mediaFixture(ATTACHMENT, MESSAGE, {
      direction: "IN", expiresAt: clock + 1_000_000,
    });
    await history.persistVerifiedMediaAndAck(metadata, bytes, async () => undefined);
    await history.clearMedia();
    expect(rawCount("media_attachments")).toBe(0);
    expect(await port.keys(A)).toEqual([]);
    expect(await history.listMedia(CONVERSATION)).toEqual([]);
    await history.close();
  });

  it("removes one message's attachment and bytes without touching another", async () => {
    const port = new FakeMediaBytes(() => clock);
    const history = await openWithMedia(port);
    await history.persistInbound(inbound());
    await history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2));
    const first = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_2, { direction: "IN", expiresAt: clock + 1_000_000 });
    await history.persistVerifiedMediaAndAck(first.metadata, first.bytes, async () => undefined);
    await history.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => undefined);

    await history.removeMediaForMessage(MESSAGE);
    expect(rawMedia(ATTACHMENT)).toBeUndefined();
    expect(await port.keys(A)).toEqual([ATTACHMENT_2]);
    // A late inbound callback for the removed attachment finds no parent row to
    // attach to only if the message itself is gone; the deletion marker is the
    // real defence and it is exercised by the suppression test above.
    expect((await history.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([ATTACHMENT_2]);
    await history.close();
  });

  it("lists visible attachments in message order", async () => {
    const history = await openWithMedia(new FakeMediaBytes(() => clock));
    await history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2));
    await history.persistInbound(inbound());
    const second = await mediaFixture(ATTACHMENT_2, MESSAGE_2, { direction: "IN", expiresAt: clock + 1_000_000 });
    const first = await mediaFixture(ATTACHMENT, MESSAGE, { direction: "IN", expiresAt: clock + 1_000_000 });
    await history.persistVerifiedMediaAndAck(second.metadata, second.bytes, async () => undefined);
    await history.persistVerifiedMediaAndAck(first.metadata, first.bytes, async () => undefined);
    expect((await history.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([ATTACHMENT, ATTACHMENT_2]);
    await history.close();
  });

  it("round-trips an image-only message through exportSnapshot and importSnapshot", async () => {
    const history = await openWithMedia(new FakeMediaBytes(() => clock));
    await history.persistInbound(inbound({ body: "" }));
    const snapshot = await history.exportSnapshot();
    // `''` is "no caption", never suppression: the portable form keeps it.
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]!.body).toBe("");

    const otherDatabase = new DatabaseSync(join(dir, "image-only-restore.db"));
    const restored = await openOn(otherDatabase, { accountId: A, deviceId: OTHER_DEVICE });
    await restored.importSnapshot(snapshot);
    expect(await restored.getMessage(MESSAGE)).toMatchObject({ body: "" });
    expect((await restored.exportSnapshot()).messages[0]!.body).toBe("");
    // The stored column is an empty string, not NULL.
    expect(otherDatabase.prepare("select body from messages where id = ?").get(MESSAGE)).toEqual({ body: "" });
    await restored.close();
    await history.close();
  });
});
