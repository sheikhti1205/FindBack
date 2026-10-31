// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import { createBackup, decodeBackup, normaliseSnapshot } from "./backup";
import type { HumanMessage, MessagingHistory } from "./history";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { accountId: id(1), deviceId: id(3) };
const base = { id: id(4), conversationId: id(5), authorId: id(1), recipientId: id(2) };
const location = { lat: 23.81, lng: 90.41, accuracy: 25 };
const payloads: HumanMessage[] = [
  { ...base, body: "Is this yours?", messageType: "TEXT", contextReportId: id(7) },
  { ...base, body: "", messageType: "LOCATION", location },
  { ...base, body: "", messageType: "LOCATION", location: { lat: 23.81, lng: 90.41, accuracy: null } },
];

describe.each(["sqlite", "web"] as const)("%s bounded message payload", (backend) => {
  let directory: string, factories: Map<string, IDBFactory>, handles: MessagingHistory[];
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "chat-context-")); factories = new Map(); handles = []; });
  afterEach(async () => { for (const h of handles) await h.close(); rmSync(directory, { recursive: true, force: true }); });
  async function open(name = "history") {
    let history: MessagingHistory;
    if (backend === "web") {
      if (!factories.has(name)) factories.set(name, new IDBFactory());
      history = await openWebMessagingHistory(scope, { indexedDB: factories.get(name) });
    }
    else {
      const db = new DatabaseSync(join(directory, `${name}.db`));
      history = await openSqliteMessagingHistory({
        exec: (sql) => db.exec(sql),
        all: <T>(sql: string, params: readonly (string | number | null)[] = []) => db.prepare(sql).all(...params) as T[],
        run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes), close: () => db.close(),
      }, scope);
    }
    handles.push(history); return history;
  }
  function receive(h: MessagingHistory, message: HumanMessage) {
    return h.persistInbound({ ...scope, mailboxId: id(8), event: { kind: "TEXT", eventId: id(9), sequence: 1, message } });
  }

  it.each(payloads)("keeps $messageType payload in claims and after restart", async (message) => {
    let h = await open(); await h.enqueueOutgoing(message, "connected:1");
    const attempt = await h.claimNextOutgoing(); expect(attempt?.message).toEqual(message);
    await h.close(); h = await open(); expect(await h.getMessage(message.id)).toMatchObject(message);
  });
  it.each(payloads)("round-trips $messageType through a portable backup", async (message) => {
    const h = await open(); await receive(h, message);
    const backup = await createBackup(h, scope, 100);
    const decoded = await decodeBackup(JSON.parse(JSON.stringify(backup)));
    const target = await open("restored"); await target.importSnapshot(normaliseSnapshot(decoded.snapshot));
    expect(await target.getMessage(message.id)).toMatchObject(message);
  });
  it.each(payloads)("rejects changed $messageType payload under the same identity", async (message) => {
    const h = await open(); await receive(h, message);
    const changed = message.location ? { ...message, location: { ...location, lat: 24 } }
      : { ...message, contextReportId: id(10) };
    await expect(receive(h, changed)).rejects.toThrow(/conflict/i);
    const snapshot = await h.exportSnapshot();
    snapshot.messages[0] = { ...snapshot.messages[0]!, ...(changed.location ? { location: changed.location } : { contextReportId: changed.contextReportId }) };
    await expect(h.importSnapshot(snapshot)).rejects.toThrow(/conflict/i);
    expect(await h.getMessage(message.id)).toMatchObject(message);
  });
  for (const action of ["UNSEND", "DELETE_FOR_ME", "CLEAR_FOR_ME"] as const) {
    it.each(payloads)(`${action} erases $messageType payload and stale backup/mailbox cannot restore it`, async (message) => {
      const h = await open(); await receive(h, message); const stale = await h.exportSnapshot();
      const common = { eventId: id(11), sequence: 1, conversationId: base.conversationId };
      await h.applyStateChange({ ...scope, change: action === "CLEAR_FOR_ME"
        ? { ...common, kind: action, peerId: base.recipientId, throughSequence: 1, occurredAt: 100 }
        : { ...common, kind: action, messageId: base.id, messageSequence: 1,
          authorId: base.authorId, recipientId: base.recipientId, occurredAt: 100 } });
      await h.importSnapshot(stale); await receive(h, message);
      const row = (await h.exportSnapshot()).messages[0]!;
      expect(row.body).toBeNull(); expect(row.contextReportId ?? null).toBeNull(); expect(row.location ?? null).toBeNull();
      const backup = await createBackup(h, scope, 100); await expect(decodeBackup(JSON.parse(JSON.stringify(backup)))).resolves.toBeTruthy();
    });
  }
});
