// @vitest-environment node
/**
 * Backup/restore against a real SQLite engine: proves the merge SQL, the
 * transaction rollback and the anti-resurrection backstop. Not the Capacitor
 * bridge, an Android device, or Drive transport.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistorySnapshot, HumanMessage, MailboxEnvelope, SnapshotMessage } from "./history";
import {
  createBackup, digestOf, encodeBackup, normaliseSnapshot, restoreBackup,
} from "./backup";
import {
  openSqliteMessagingHistory, type SqliteDriver, type SqliteMessagingHistory,
} from "./sqliteHistory";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const FOREIGN = "00000000-0000-4000-8000-0000000000ff";
const DEVICE = "00000000-0000-4000-8000-000000000004";
const OTHER_DEVICE = "00000000-0000-4000-8000-000000000005";
const CONVERSATION = "00000000-0000-4000-8000-000000000006";
const MESSAGE = "00000000-0000-4000-8000-000000000008";
const MESSAGE_2 = "00000000-0000-4000-8000-000000000009";
const EVENT = "00000000-0000-4000-8000-00000000000a";
const EVENT_2 = "00000000-0000-4000-8000-00000000000b";
const MAILBOX = "00000000-0000-4000-8000-00000000000c";
const MAILBOX_2 = "00000000-0000-4000-8000-00000000000d";

let dir: string;
let clock: number;
const dbs = new Map<string, DatabaseSync>();

function driverFor(db: DatabaseSync): SqliteDriver {
  return {
    exec: (sql) => { db.exec(sql); },
    all: (sql, params = []) => db.prepare(sql).all(...params) as never,
    run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
    close: () => db.close(),
  };
}

async function store(name: string, deviceId = DEVICE): Promise<SqliteMessagingHistory> {
  const db = new DatabaseSync(join(dir, `${name}.db`));
  dbs.set(name, db);
  return openSqliteMessagingHistory(driverFor(db), { accountId: A, deviceId }, {
    now: () => clock,
    token: () => `token-${clock}`,
  });
}

/**
 * Read the stored body directly. Visibility helpers hide erased rows, so they
 * cannot prove erasure at rest — and erasure at rest is the actual promise.
 */
function bodyAtRest(name: string, messageId: string): string | null {
  const row = dbs.get(name)!.prepare("select body from messages where id = ?").get(messageId);
  return row ? (row as { body: string | null }).body : "missing";
}

function envelope(
  message: Partial<HumanMessage>,
  event: string,
  mailbox: string,
  sequence: number,
  deviceId = DEVICE,
): MailboxEnvelope {
  return {
    accountId: A,
    deviceId,
    mailboxId: mailbox,
    event: {
      kind: "TEXT",
      eventId: event,
      sequence,
      message: { id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A, body: "Reply text", ...message },
    },
  };
}

async function seal(snapshot: HistorySnapshot) {
  const envelope = {
    format: "findback.chat.backup" as const, version: 1, accountId: A,
    deviceId: DEVICE, exportedAt: clock, snapshot,
  };
  return { ...envelope, digest: await digestOf(envelope) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "findback-backup-"));
  clock = 1_700_000_000_000;
  dbs.clear();
});
afterEach(() => {
  for (const db of dbs.values()) { try { db.close(); } catch { /* adapter closed it */ } }
  rmSync(dir, { recursive: true, force: true });
});

describe("backup round trip", () => {
  it("merges classification without downgrade and rejects conflicting known types transactionally", async () => {
    const source = await store("source"), target = await store("target");
    await source.persistInbound(envelope({ messageType: "MEDIA" }, EVENT, MAILBOX, 1));
    const classified = await source.exportSnapshot();
    const legacy = { ...classified, messages: classified.messages.map(({ messageType: _type, ...row }) => row) };
    await target.importSnapshot(legacy);
    expect((await target.getMessage(MESSAGE))?.messageType).toBeUndefined();
    await target.importSnapshot(classified);
    await target.importSnapshot(legacy);
    expect((await target.getMessage(MESSAGE))?.messageType).toBe("MEDIA");
    const before = await target.exportSnapshot();
    await expect(target.importSnapshot({ ...classified,
      messages: classified.messages.map((row) => ({ ...row, messageType: "TEXT" })) }))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    expect(await target.exportSnapshot()).toEqual(before);
  });

  it("preserves MEDIA classification through a sealed snapshot and restore", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({ body: "", messageType: "MEDIA" } as Partial<HumanMessage>, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    expect(backup.snapshot.messages).toMatchObject([{ id: MESSAGE, body: "", messageType: "MEDIA" }]);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(await target.getMessage(MESSAGE)).toMatchObject({ body: "", messageType: "MEDIA" });
    await target.close();
  });

  it("restores accepted history, the conversation and the erasure metadata", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await source.persistInbound(envelope({ id: MESSAGE_2, body: "Second" }, EVENT_2, MAILBOX_2, 2));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    const report = await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(report.messages).toBe(2);
    expect(report.conversations).toBe(1);
    expect(await target.listMessages(CONVERSATION)).toMatchObject([
      { id: MESSAGE, body: "Reply text", server: { eventId: EVENT, sequence: 1 } },
      { id: MESSAGE_2, body: "Second", server: { eventId: EVENT_2, sequence: 2 } },
    ]);
    // A restore is not metadata application: it must never claim a state cursor.
    expect(await target.getStateCursor()).toBeNull();
    await target.close();
  });

  it("round-trips through the encoded string without losing suppression metadata", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await source.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 5, unsentBy: B });
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(await target.getMessage(MESSAGE)).toMatchObject({ body: "", unsentAt: clock + 5 });
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });
});

describe("backup rejection", () => {
  it("refuses another account's backup and writes nothing", async () => {
    // A genuinely sealed envelope for a different account: the account guard must
    // reject it on its own, not because the digest happened to fail first.
    const envelope = {
      format: "findback.chat.backup" as const, version: 1, accountId: FOREIGN,
      deviceId: DEVICE, exportedAt: clock,
      snapshot: { conversations: [], messages: [], tombstones: [], deletedForMe: [], clears: [] },
    };
    const foreign = { ...envelope, digest: await digestOf(envelope) };

    const target = await store("target", OTHER_DEVICE);
    await expect(restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, foreign))
      .rejects.toMatchObject({ code: "backup: account mismatch" });
    expect(await target.listMessages(CONVERSATION)).toEqual([]);
    expect(await target.listConversations()).toEqual([]);
    await target.close();
  });

  it("refuses a tampered body and writes nothing", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    const tampered = JSON.parse(encodeBackup(backup)) as typeof backup;
    tampered.snapshot.messages[0]!.body = "Injected";
    await expect(restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, tampered))
      .rejects.toMatchObject({ code: "backup: digest mismatch" });
    expect(await target.listMessages(CONVERSATION)).toEqual([]);
    await target.close();
  });

  it("refuses an identity contradiction and rolls the whole import back", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    // The same message id is already stored here in the opposite direction.
    await target.persistInbound(envelope({ authorId: A, recipientId: B, body: "Different author" },
      EVENT, MAILBOX, 1, OTHER_DEVICE));

    // The snapshot inserts a brand-new message first and then contradicts the
    // existing one. If the import were not atomic, the new row would survive.
    const snapshot = normaliseSnapshot({
      ...backup.snapshot,
      messages: [
        { id: MESSAGE_2, conversationId: CONVERSATION, authorId: B, recipientId: A,
          body: "Imported", serverEventId: EVENT_2, serverSequence: 2, unsentAt: null, createdAt: clock },
        { ...backup.snapshot.messages[0]!, authorId: A, recipientId: B },
      ],
    });
    await expect(target.importSnapshot(snapshot))
      .rejects.toMatchObject({ code: "backup: identity conflict" });

    // The new message never landed, and the local row is untouched.
    expect(await target.getMessage(MESSAGE_2)).toBeNull();
    expect(bodyAtRest("target", MESSAGE_2)).toBe("missing");
    expect(await target.getMessage(MESSAGE)).toMatchObject({ authorId: A, body: "Different author" });
    await target.close();
  });

  it("refuses two known conversations for one personal deletion", async () => {
    // `coalesce` would make this merge direction-dependent, so two *known* but
    // different conversations must fail closed instead.
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    const { digest: _drop, ...rest } = {
      ...backup,
      snapshot: {
        ...backup.snapshot,
        deletedForMe: [{ messageId: MESSAGE, conversationId: CONVERSATION, deletedAt: clock }],
      },
    };
    const sealed = { ...rest, digest: await digestOf(rest) };
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    await target.deleteForMe(MESSAGE);
    // The local deletion names the same message under a different conversation.
    dbs.get("target")!.prepare("update deleted_for_me set conversation_id = ? where message_id = ?")
      .run("00000000-0000-4000-8000-0000000000ee", MESSAGE);

    await expect(restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, sealed))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    await target.close();
  });

  it("refuses a snapshot that reuses a conversation sequence for another message", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    // A different message claiming the sequence this store already used.
    const snapshot = normaliseSnapshot({
      ...backup.snapshot,
      messages: [{ ...backup.snapshot.messages[0]!, id: MESSAGE_2 }],
    });
    // The documented code, never a raw SQLite constraint error.
    await expect(target.importSnapshot(snapshot))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    expect(await target.getMessage(MESSAGE_2)).toBeNull();
    await target.close();
  });
});

describe("anti-resurrection", () => {
  it("keeps a local unsend tombstone authoritative over a stale backup body", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    await target.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 1, unsentBy: B });

    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect((await target.getMessage(MESSAGE))?.body).toBe("");
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("keeps a local delete-for-me authoritative over a stale backup body", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    await target.deleteForMe(MESSAGE);

    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(await target.getMessage(MESSAGE)).toBeNull();
    expect(await target.listMessages(CONVERSATION)).toEqual([]);
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("keeps a local clear authoritative over a stale backup body", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    await target.clearThrough(CONVERSATION, 1);

    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(await target.getMessage(MESSAGE)).toBeNull();
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("suppresses a body the snapshot pairs with an unsend timestamp", async () => {
    // An unsent message is never readable, so a snapshot claiming both a body
    // and an unsend time is internally contradictory. The backstop resolves it
    // the only safe way, without needing the tombstone row to travel.
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    const { digest: _drop, ...rest } = {
      ...backup,
      snapshot: {
        ...backup.snapshot,
        messages: backup.snapshot.messages.map((message: SnapshotMessage) => ({
          ...message, body: "Resurrected", unsentAt: clock + 9,
        })),
        tombstones: [],
      },
    };
    const sealed = { ...rest, digest: await digestOf(rest) };
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, sealed);
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    expect((await target.getMessage(MESSAGE))?.body).toBe("");
    await target.close();
  });

  it("adopts a suppression the backup carries over a locally visible body", async () => {
    // A metadata-only suppressed message: the snapshot has no body and no
    // tombstone row of its own. Suppression must still win over the local body,
    // and it must be the merge rule that does it — not the tombstone backstop.
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    const { digest: _drop, ...rest } = {
      ...backup,
      snapshot: {
        ...backup.snapshot,
        messages: backup.snapshot.messages.map((message: SnapshotMessage) => ({ ...message, body: null })),
        tombstones: [],
      },
    };
    const sealed = { ...rest, digest: await digestOf(rest) };
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    expect(bodyAtRest("target", MESSAGE)).toBe("Reply text");

    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, sealed);
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    expect((await target.getMessage(MESSAGE))?.body).toBe("");
    await target.close();
  });

  it("suppresses a body carried by the backup itself when the backup also carries the tombstone", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    // A snapshot that claims a body *and* a tombstone for the same message, then
    // sealed so the digest is valid: the backstop must win over the claimed body.
    const { digest: _drop, ...rest } = {
      ...backup,
      snapshot: {
        ...backup.snapshot,
        messages: backup.snapshot.messages.map((message: SnapshotMessage) => ({ ...message, body: "Resurrected" })),
        tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
          unsentAt: clock + 2, unsentBy: B }],
      },
    };
    const sealed = { ...rest, digest: await digestOf(rest) };
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, sealed);
    expect((await target.getMessage(MESSAGE))?.body).toBe("");
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });
});

describe("untrusted caller data", () => {
  function snapshotWith(message: unknown): HistorySnapshot {
    return {
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: clock, updatedAt: clock }],
      messages: [message], tombstones: [], deletedForMe: [], clears: [],
    } as unknown as HistorySnapshot;
  }

  it("reads the caller's snapshot through one descriptor call, so a trap cannot change the merged body", async () => {
    // Direct adapter use, without decodeBackup: the adapter is a public entry
    // point and must not read caller-owned data twice.
    const target = await store("target", OTHER_DEVICE);
    let bodyReads = 0;
    const row = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: clock,
    };
    const stateful = new Proxy(row, {
      getOwnPropertyDescriptor(inner, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(inner, key);
        if (key !== "body" || !descriptor) return descriptor;
        bodyReads += 1;
        return { ...descriptor, value: bodyReads === 1 ? "Reply text" : "Resurrected" };
      },
    });
    const report = await target.importSnapshot(snapshotWith(stateful));
    expect(report.messages).toBe(1);
    expect(bodyReads).toBe(1);
    expect(bodyAtRest("target", MESSAGE)).toBe("Reply text");
    await target.close();
  });

  it("does not let an array proxy hide a row behind a forged length, and writes nothing", async () => {
    // The adapter is a public entry point with no envelope and no digest, so a
    // silently empty array would look like a successful empty import.
    const target = await store("target", OTHER_DEVICE);
    const row = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: clock,
    };
    const hidden = new Proxy([row], {
      get(inner, key, receiver) {
        return key === "length" ? 0 : Reflect.get(inner, key, receiver);
      },
      ownKeys: () => ["length"],
    });
    const snapshot = {
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: clock, updatedAt: clock }],
      messages: hidden, tombstones: [], deletedForMe: [], clears: [],
    } as unknown as HistorySnapshot;
    await expect(target.importSnapshot(snapshot))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
    expect(bodyAtRest("target", MESSAGE)).toBe("missing");
    await target.close();
  });

  it("refuses an accessor instead of running it, and writes nothing", async () => {
    const target = await store("target", OTHER_DEVICE);
    let reads = 0;
    const message = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
      get body(): string { reads += 1; throw new Error("hostile accessor"); },
      serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: clock,
    };
    await expect(target.importSnapshot(snapshotWith(message)))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
    expect(reads).toBe(0);
    expect(await target.listMessages(CONVERSATION)).toEqual([]);
    expect(bodyAtRest("target", MESSAGE)).toBe("missing");
    await target.close();
  });
});

describe("tombstone identity", () => {
  it("refuses a tombstone that contradicts the message it would suppress", async () => {
    // The backstop matches on message id alone, so a tombstone claiming a
    // different author must not be allowed to erase a visible message.
    const target = await store("target");
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    expect(bodyAtRest("target", MESSAGE)).toBe("Reply text");

    const sealed = await seal({
      conversations: [], messages: [],
      tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: B,
        unsentAt: clock + 1, unsentBy: A }],
      deletedForMe: [], clears: [],
    });
    await expect(restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    expect(bodyAtRest("target", MESSAGE)).toBe("Reply text");
    expect(dbs.get("target")!.prepare("select count(*) as n from tombstones").get()).toEqual({ n: 0 });
    await target.close();
  });

  it("refuses a message that contradicts an existing tombstone", async () => {
    const target = await store("target");
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await target.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 1, unsentBy: B });
    // A poisoned local tombstone: it names an unsender who did not author the
    // message. Defence in depth — the message must not be adopted over it.
    dbs.get("target")!.prepare("update tombstones set unsent_by = ? where message_id = ?").run(A, MESSAGE);

    const sealed = await seal({
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: clock, updatedAt: clock }],
      messages: [{ id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
        body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: clock }],
      tombstones: [], deletedForMe: [], clears: [],
    });
    await expect(restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("refuses a tombstone whose unsend time contradicts the message", async () => {
    const target = await store("target");
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await target.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 1, unsentBy: B });
    // The stored message now claims a different unsend time than any tombstone
    // that arrives for it, so the two rows would describe different events.
    dbs.get("target")!.prepare("update messages set unsent_at = ? where id = ?").run(clock + 5, MESSAGE);

    const sealed = await seal({
      conversations: [], messages: [],
      tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
        unsentAt: clock + 1, unsentBy: B }],
      deletedForMe: [], clears: [],
    });
    await expect(restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    await target.close();
  });

  it("refuses a same-snapshot message and tombstone that disagree on the unsend time", async () => {
    const target = await store("target");
    const sealed = await seal({
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: clock, updatedAt: clock }],
      messages: [{ id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
        body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: clock + 5, createdAt: clock }],
      tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
        unsentAt: clock + 1, unsentBy: B }],
      deletedForMe: [], clears: [],
    });
    await expect(restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed))
      .rejects.toMatchObject({ code: "backup: identity conflict" });
    expect(bodyAtRest("target", MESSAGE)).toBe("missing");
    await target.close();
  });

  it("adopts the tombstone's unsend time for a message that has none", async () => {
    const target = await store("target");
    const sealed = await seal({
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: clock, updatedAt: clock }],
      messages: [{ id: MESSAGE, conversationId: CONVERSATION, authorId: B, recipientId: A,
        body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: clock }],
      tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
        unsentAt: clock + 7, unsentBy: B }],
      deletedForMe: [], clears: [],
    });
    await restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed);
    // One event, one time: the message adopts the tombstone's stamp instead of
    // leaving the two rows disagreeing.
    expect(dbs.get("target")!.prepare("select unsent_at as u from messages where id = ?").get(MESSAGE))
      .toEqual({ u: clock + 7 });
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("binds an unbound legacy tombstone from the message it describes", async () => {
    const target = await store("target");
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1));

    const sealed = await seal({
      conversations: [], messages: [],
      tombstones: [{ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: null,
        unsentAt: clock + 2, unsentBy: B }],
      deletedForMe: [], clears: [],
    });
    await restoreBackup(target, { accountId: A, deviceId: DEVICE }, sealed);
    // Bound to the real recipient rather than left as a wildcard, and suppressed.
    expect(dbs.get("target")!.prepare("select recipient_id as r from tombstones where message_id = ?").get(MESSAGE))
      .toEqual({ r: A });
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });
});

describe("merge semantics", () => {
  it("is idempotent", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    const scope = { accountId: A, deviceId: OTHER_DEVICE };
    const first = await restoreBackup(target, scope, encodeBackup(backup));
    const before = await target.listMessages(CONVERSATION);
    const second = await restoreBackup(target, scope, encodeBackup(backup));
    expect(second).toEqual(first);
    expect(await target.listMessages(CONVERSATION)).toEqual(before);
    await target.close();
  });

  it("reaches the same state in both merge directions", async () => {
    // Two devices observed different halves of the same conversation.
    const left = await store("left");
    await left.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await left.recordUnsend({ messageId: MESSAGE_2, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 3, unsentBy: B });
    const right = await store("right", OTHER_DEVICE);
    await right.persistInbound(envelope({ id: MESSAGE_2, body: "Second" }, EVENT_2, MAILBOX_2, 2, OTHER_DEVICE));
    await right.deleteForMe(MESSAGE);

    const scope = { accountId: A, deviceId: DEVICE };
    const leftBackup = await createBackup(left, scope, clock);
    const rightBackup = await createBackup(right, scope, clock);
    await left.close();
    await right.close();

    const leftIntoRight = await store("leftIntoRight", OTHER_DEVICE);
    await restoreBackup(leftIntoRight, scope, encodeBackup(leftBackup));
    await restoreBackup(leftIntoRight, scope, encodeBackup(rightBackup));
    const a = {
      messages: await leftIntoRight.listMessages(CONVERSATION),
      erased: await leftIntoRight.getMessage(MESSAGE),
      erasedBody: bodyAtRest("leftIntoRight", MESSAGE),
    };
    await leftIntoRight.close();

    const rightIntoLeft = await store("rightIntoLeft");
    await restoreBackup(rightIntoLeft, scope, encodeBackup(rightBackup));
    await restoreBackup(rightIntoLeft, scope, encodeBackup(leftBackup));
    const b = {
      messages: await rightIntoLeft.listMessages(CONVERSATION),
      erased: await rightIntoLeft.getMessage(MESSAGE),
      erasedBody: bodyAtRest("rightIntoLeft", MESSAGE),
    };
    await rightIntoLeft.close();

    expect(a).toEqual(b);
    // Both directions must agree on suppression, not merely on row identity.
    expect(a.erased).toBeNull();
    expect(a.erasedBody).toBeNull();
    expect(a.messages.map((message) => message.id)).toEqual([MESSAGE_2]);
    expect(a.messages[0]?.body).toBe("");
  });

  it("does not resurrect a body on a later inbound replay after an import", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await source.recordUnsend({ messageId: MESSAGE, conversationId: CONVERSATION, recipientId: A,
      unsentAt: clock + 4, unsentBy: B });
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    // A replay of the original TEXT envelope must not restore the body.
    await target.persistInbound(envelope({}, EVENT, MAILBOX, 1, OTHER_DEVICE));
    expect((await target.getMessage(MESSAGE))?.body).toBe("");
    expect(bodyAtRest("target", MESSAGE)).toBeNull();
    await target.close();
  });

  it("never imports the outbox or mailbox receipts", async () => {
    const source = await store("source");
    await source.persistInbound(envelope({}, EVENT, MAILBOX, 1));
    await source.enqueueOutgoing({ id: MESSAGE_2, conversationId: CONVERSATION, authorId: A,
      recipientId: B, body: "Pending" });
    const backup = await createBackup(source, { accountId: A, deviceId: DEVICE }, clock);
    expect(backup.snapshot.messages.map((message) => message.id)).toEqual([MESSAGE]);
    await source.close();

    const target = await store("target", OTHER_DEVICE);
    await restoreBackup(target, { accountId: A, deviceId: OTHER_DEVICE }, encodeBackup(backup));
    expect(await target.listOutbox()).toEqual([]);
    const db = dbs.get("target")!;
    expect(db.prepare("select count(*) as n from mailbox_seen").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from messaging_state_events").get()).toEqual({ n: 0 });
    await target.close();
  });
});
