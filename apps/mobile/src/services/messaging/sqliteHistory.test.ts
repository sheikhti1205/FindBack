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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HumanMessage, MailboxEnvelope } from "./history";
import { openSqliteMessagingHistory, type SqliteDriver, type SqliteHistoryOptions } from "./sqliteHistory";
import { MESSAGING_SQLITE_SCHEMA, MESSAGING_SQLITE_SCHEMA_VERSION } from "./sqliteSchema";

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

function driverFor(db: DatabaseSync, beforeStatement?: (sql: string) => void): SqliteDriver {
  return {
    exec: (sql) => {
      beforeStatement?.(sql);
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
  beforeExec?: (sql: string) => void,
) {
  return openSqliteMessagingHistory(driverFor(db, beforeExec), identity, {
    now: () => clock,
    token: () => `token-${clock}`,
    ...options,
  });
}

function open(beforeExec?: (sql: string) => void) {
  return openOn(database, { accountId: A, deviceId: DEVICE }, {}, beforeExec);
}

function rawCount(table: "messages" | "mailbox_seen" | "conversations" | "outbox"): number {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "findback-sqlite-"));
  path = join(dir, "messaging.db");
  database = new DatabaseSync(path);
  clock = 1_700_000_000_000;
});
afterEach(() => {
  try { database.close(); } catch { /* already closed by the adapter */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("schema and durability", () => {
  it("verifies WAL, full synchronous durability and enforced foreign keys on its own connection", () => {
    const history = open();
    expect(database.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("pragma synchronous").get()).toEqual({ synchronous: 2 });
    expect(database.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("select value from messaging_meta where key = 'schema_version'").get())
      .toEqual({ value: String(MESSAGING_SQLITE_SCHEMA_VERSION) });
    history.close();
  });

  it("refuses an in-memory database instead of issuing durable receipts from it", () => {
    const memory = new DatabaseSync(":memory:");
    expect(() => openOn(memory)).toThrow(/durable file-backed database/);
    expect(() => memory.prepare("select 1").get()).toThrow();
  });

  it("refuses an unsupported future schema version rather than downgrading it", () => {
    open().close();
    const raw = new DatabaseSync(path);
    raw.prepare("update messaging_meta set value = '2' where key = 'schema_version'").run();
    raw.close();
    database = new DatabaseSync(path);
    expect(() => open()).toThrow(/Unsupported messaging schema version/);
  });

  it("cascades a conversation delete through its messages on the adapter connection", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    database.exec(`delete from conversations where id = '${CONVERSATION}'`);
    expect(database.prepare("select count(*) as n from messages").get()).toEqual({ n: 0 });
    expect(database.prepare("select count(*) as n from outbox").get()).toEqual({ n: 0 });
    history.close();
  });

  it("enforces foreign keys, body bounds and outbox lease invariants in SQL", () => {
    open().close();
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

  it("keeps every schema statement idempotent", () => {
    open().close();
    database = new DatabaseSync(path);
    for (const statement of MESSAGING_SQLITE_SCHEMA) database.exec(statement);
  });

  it("enforces one authoritative event identity per stored message in SQL", () => {
    open().close();
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

  it("rejects an invalid lease duration", () => {
    expect(() => openOn(database, { accountId: A, deviceId: DEVICE }, { leaseMs: 0 }))
      .toThrow(/Invalid messaging lease duration/);
  });
});

describe("account/installation binding", () => {
  it("refuses a database file created for another account or installation", () => {
    open().close();
    database = new DatabaseSync(path);
    expect(() => openOn(database, { accountId: B, deviceId: DEVICE })).toThrow(/different account/);

    database = new DatabaseSync(path);
    expect(() => openOn(database, { accountId: A, deviceId: OTHER_DEVICE })).toThrow(/different installation/);
  });

  it("binds atomically: a competing initializer cannot overwrite an established identity", () => {
    const competitorDb = new DatabaseSync(path);
    let attempted = false;
    let competitor: ReturnType<typeof openSqliteMessagingHistory> | null = null;
    let firstError: unknown = null;

    try {
      // The hook runs before this initializer takes its write lock, so a second
      // legitimate initializer completes its own binding first. The loser must fail
      // rather than silently rebind the shared file.
      open((sql) => {
        if (sql !== "begin immediate" || attempted) return;
        attempted = true;
        competitor = openOn(competitorDb, { accountId: B, deviceId: OTHER_DEVICE });
      });
    } catch (error) {
      firstError = error;
    }

    expect(attempted).toBe(true);
    expect(firstError).toBeInstanceOf(Error);
    expect(competitor).not.toBeNull();
    competitor!.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare("select value from messaging_meta where key = 'account_id'").get()).toEqual({ value: B });
    raw.close();

    database = new DatabaseSync(path);
    expect(() => openOn(database, { accountId: A, deviceId: DEVICE })).toThrow(/different account/);
  });

  it("lets two initializers with the same identity share the file idempotently", () => {
    const second = new DatabaseSync(path);
    const first = open();
    const other = openOn(second);
    expect(other).toBeDefined();
    other.close();
    first.close();
  });
});

describe("durable outgoing text", () => {
  it("stores a message with a queued outbox entry and is idempotent on replay", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    await history.enqueueOutgoing({ ...outgoing });
    expect(await history.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    history.close();
  });

  it("rejects changed immutable content under the same message id", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "different" })).rejects.toThrow(/Conflicting/);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    history.close();
  });

  it("rejects an outgoing message for another account", async () => {
    const history = open();
    await expect(history.enqueueOutgoing({ ...outgoing, authorId: B, recipientId: C }))
      .rejects.toThrow(/Outgoing messaging scope mismatch/);
    expect(await history.listOutbox()).toEqual([]);
    history.close();
  });

  it("validates identity, body and participants", async () => {
    const history = open();
    await expect(history.enqueueOutgoing({ ...outgoing, id: "not-a-uuid" })).rejects.toThrow(/UUID/);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "  " })).rejects.toThrow(/text/);
    await expect(history.enqueueOutgoing({ ...outgoing, body: "a\u0000b" })).rejects.toThrow(/text/);
    await expect(history.enqueueOutgoing({ ...outgoing, recipientId: A })).rejects.toThrow(/participants/);
    history.close();
  });
});

describe("outgoing confirmation", () => {
  it("confirms a QUEUED message from its authoritative echo and clears the outbox", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    const receipt = await history.persistInbound(echoOf());
    expect(receipt).toEqual({ accountId: A, deviceId: DEVICE, mailboxId: MAILBOX, eventId: EVENT });
    expect(await history.getMessage(MESSAGE)).toMatchObject({
      body: "Hello there",
      server: { eventId: EVENT, sequence: 1 },
    });
    expect(await history.listOutbox()).toEqual([]);
    history.close();
  });

  it("confirms a SENDING message and refuses a late failure afterwards", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    await history.persistInbound(echoOf());
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.failOutgoing(attempt)).toBe(false);
    history.close();
  });

  it("confirms a FAILED message", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    expect(await history.failOutgoing(attempt)).toBe(true);
    await history.persistInbound(echoOf());
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ server: { eventId: EVENT, sequence: 1 } });
    history.close();
  });

  it("treats a replayed echo as idempotent", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    await history.persistInbound(echoOf());
    await history.persistInbound(echoOf());
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    expect(rawCount("mailbox_seen")).toBe(1);
    history.close();
  });

  it("rejects an echo whose body changed and keeps the pending message queued", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    await expect(history.persistInbound(echoOf({ ...outgoing, body: "tampered" })))
      .rejects.toThrow(/Immutable message conflict/);
    expect(await history.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Hello there" });
    expect((await history.getMessage(MESSAGE))?.server).toBeUndefined();
    history.close();
  });
});

describe("leases and failures", () => {
  it("leases one attempt at a time and re-claims only after expiry", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);

    const first = await history.claimNextOutgoing();
    expect(first).toMatchObject({ token: `token-${clock}`, attempt: 1, message: { id: MESSAGE } });
    expect(await history.claimNextOutgoing()).toBeNull();

    clock += 59_999;
    expect(await history.claimNextOutgoing()).toBeNull();

    clock += 1;
    const second = await history.claimNextOutgoing();
    expect(second).toMatchObject({ attempt: 2, message: { id: MESSAGE } });
    history.close();
  });

  it("fences a stale failure by attempt generation even when the token repeats", async () => {
    const history = open();
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
    history.close();
  });

  it("rejects a failure attempt with mismatched message identity or generation", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    const attempt = await history.claimNextOutgoing();
    if (!attempt) throw new Error("claim failed");
    await expect(history.failOutgoing({ ...attempt, message: { ...attempt.message, body: "changed" } }))
      .rejects.toThrow(/identity conflict/);
    await expect(history.failOutgoing({ ...attempt, attempt: 0 })).rejects.toThrow(/generation/);
    expect(await history.listOutbox()).toHaveLength(1);
    history.close();
  });
});

describe("inbound identity, scope and atomicity", () => {
  it("persists message, event identity and mailbox identity in one transaction", async () => {
    const history = open();
    const receipt = await history.persistInbound(inbound());
    expect(receipt).toEqual({ accountId: A, deviceId: DEVICE, mailboxId: MAILBOX, eventId: EVENT });
    expect(await history.getMessage(MESSAGE)).toMatchObject({
      body: "Reply text",
      server: { eventId: EVENT, sequence: 1 },
    });
    history.close();
  });

  it("rejects an inbound message this account does not participate in", async () => {
    const history = open();
    await expect(history.persistInbound(inbound({ authorId: B, recipientId: C })))
      .rejects.toThrow(/Inbound participant scope mismatch/);
    expect(await history.listMessages(CONVERSATION)).toEqual([]);
    history.close();
  });

  it("rejects an envelope outside this installation scope", async () => {
    const history = open();
    await expect(history.persistInbound({ ...inbound(), deviceId: OTHER_DEVICE }))
      .rejects.toThrow(/scope/);
    await expect(history.persistInbound({ ...inbound(), accountId: B }))
      .rejects.toThrow(/scope/);
    history.close();
  });

  it("rejects one event identity mapped to two messages", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT, MAILBOX_2, 2)))
      .rejects.toThrow(/Immutable event identity conflict/);
    expect(rawCount("messages")).toBe(1);
    history.close();
  });

  it("rejects mailbox reuse for a different message or sequence", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX, 2)))
      .rejects.toThrow(/Immutable mailbox identity conflict/);
    await expect(history.persistInbound(inbound({}, EVENT, MAILBOX, 9)))
      .rejects.toThrow(/Immutable mailbox identity conflict/);
    history.close();
  });

  it("rejects a changed conversation for the same message identity without moving a cursor", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(
      inbound({ conversationId: OTHER_CONVERSATION }, EVENT, MAILBOX, 1),
    )).rejects.toThrow(/Immutable/);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("select count(*) as n from conversations where id = ?").get(OTHER_CONVERSATION))
      .toEqual({ n: 0 });
    raw.close();
    history.close();
  });

  it("rejects duplicate authoritative sequence without partial state", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await expect(history.persistInbound(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 1)))
      .rejects.toThrow(/UNIQUE|Immutable/);
    expect(await history.listMessages(CONVERSATION)).toHaveLength(1);
    history.close();
  });

  it("orders by authoritative sequence, not arrival order", async () => {
    const history = open();
    await history.persistInbound(inbound({ id: MESSAGE_2, body: "second" }, EVENT_2, MAILBOX_2, 2));
    await history.persistInbound(inbound({ id: MESSAGE, body: "first" }, EVENT, MAILBOX, 1));
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["first", "second"]);
    history.close();
  });

  it("sees nothing on another connection before COMMIT", async () => {
    let armed = false;
    let beforeCommit = -1;
    const history = open((sql) => {
      if (!armed || sql !== "commit" || beforeCommit !== -1) return;
      beforeCommit = rawCount("messages");
    });
    armed = true;
    await history.persistInbound(inbound());
    expect(beforeCommit).toBe(0);
    expect(rawCount("messages")).toBe(1);
    history.close();
  });

  it("rolls back a mid-transaction failure and never acknowledges it", async () => {
    let armed = false;
    let acked = false;
    const history = open((sql) => {
      if (armed && sql.includes("insert into mailbox_seen")) throw new Error("injected failure");
    });
    armed = true;
    await expect(history.persistInboundAndAck(inbound(), async () => { acked = true; }))
      .rejects.toThrow(/injected failure/);
    expect(acked).toBe(false);
    expect(rawCount("messages")).toBe(0);
    expect(rawCount("mailbox_seen")).toBe(0);
    expect(rawCount("conversations")).toBe(0);
    history.close();
  });

  it("invokes ACK only after the commit is visible to another connection", async () => {
    const history = open();
    const seen: string[] = [];
    await history.persistInboundAndAck(inbound(), async (receipt) => {
      seen.push(receipt.eventId);
      const reader = new DatabaseSync(path);
      expect(reader.prepare("select count(*) as n from messages").get()).toEqual({ n: 1 });
      expect(reader.prepare("select count(*) as n from mailbox_seen").get()).toEqual({ n: 1 });
      reader.close();
    });
    expect(seen).toEqual([EVENT]);

    history.close();
    await expect(history.persistInboundAndAck(inbound({ id: MESSAGE_2 }, EVENT_2, MAILBOX_2, 2), async () => {
      throw new Error("must not ACK after close");
    })).rejects.toThrow(/closed/);
  });
});

describe("tombstones", () => {
  it("keeps an unsent message as a tombstone and never resurrects its body", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: B });
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });

    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    history.close();
  });

  it("stores a message that arrives after its unsend as a body-less tombstone", async () => {
    const history = open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: B });
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });
    history.close();
  });

  it("does not resurrect or queue an unsent outgoing message", async () => {
    const history = open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: A });
    await history.enqueueOutgoing(outgoing);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock });
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    history.close();
  });

  it("stops leasing a message that is unsent while pending", async () => {
    const history = open();
    await history.enqueueOutgoing(outgoing);
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: A });
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "" });
    history.close();
  });

  it("rejects an unsend that contradicts the stored author or conversation", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: A,
    })).rejects.toThrow(/Unsend author conflict/);
    await expect(history.recordUnsend({
      messageId: MESSAGE, conversationId: OTHER_CONVERSATION, unsentAt: clock, unsentBy: B,
    })).rejects.toThrow(/Unsend conversation conflict/);
    expect(await history.getMessage(MESSAGE)).toMatchObject({ body: "Reply text" });
    history.close();
  });

  it("rejects an inbound message whose author contradicts its tombstone", async () => {
    const history = open();
    await history.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, unsentAt: clock, unsentBy: A });
    await expect(history.persistInbound(inbound())).rejects.toThrow(/Unsend identity conflict/);
    history.close();
  });
});

describe("personal deletion and clear", () => {
  it("retains a delete-for-me marker that arrives before the content", async () => {
    const history = open();
    await history.deleteForMe(MESSAGE);
    await history.persistInbound(inbound());
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(await history.listMessages(CONVERSATION)).toEqual([]);
    expect(rawCount("messages")).toBe(1);
    history.close();
  });

  it("deletes for this device only and keeps the row for the other participant's copy", async () => {
    const history = open();
    await history.persistInbound(inbound());
    await history.deleteForMe(MESSAGE);
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect(await history.listMessages(CONVERSATION)).toEqual([]);

    open().close();
    expect(rawCount("messages")).toBe(1);
  });

  it("applies clear-through consistently to list and direct reads", async () => {
    const history = open();
    await history.persistInbound(inbound({ id: MESSAGE, body: "old" }, EVENT, MAILBOX, 1));
    await history.persistInbound(inbound({ id: MESSAGE_2, body: "new" }, EVENT_2, MAILBOX_2, 2));
    await history.enqueueOutgoing({ ...outgoing, id: "00000000-0000-4000-8000-00000000000e", body: "pending" });

    await history.clearThrough(CONVERSATION, 1);
    expect(await history.getMessage(MESSAGE)).toBeNull();
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["new", "pending"]);

    await history.clearThrough(CONVERSATION, 2);
    expect(await history.getMessage(MESSAGE_2)).toBeNull();
    expect((await history.listMessages(CONVERSATION)).map((m) => m.body)).toEqual(["pending"]);
    history.close();
  });
});

describe("session lifecycle", () => {
  it("closes the driver and refuses further work", async () => {
    const history = open();
    history.close();
    await expect(history.enqueueOutgoing(outgoing)).rejects.toThrow(/closed/);
    await expect(history.listMessages(CONVERSATION)).rejects.toThrow(/closed/);
    expect(() => database.prepare("select 1").get()).toThrow();
  });
});
