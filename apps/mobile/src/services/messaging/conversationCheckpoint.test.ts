// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import type { MessagingHistory } from "./history";
import type { ConversationHead } from "./conversationHead";
import { FakeMediaBytes } from "./mediaTestDoubles";

const scope = { accountId: "00000000-0000-4000-8000-000000000001", deviceId: "00000000-0000-4000-8000-000000000002" };
const conversationId = "00000000-0000-4000-8000-000000000003";
const head: ConversationHead = { accountId: scope.accountId, conversationId, streamId: "stream-a", epoch: "epoch-a",
  revision: 1, position: 3, messageHead: 3, stateHead: 0, serverTime: 1_000 };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(kind: "IndexedDB" | "SQLite") {
  const handles = new Set<MessagingHistory>();
  const factory = new IDBFactory();
  const mediaBytes = new FakeMediaBytes();
  const dir = kind === "SQLite" ? mkdtempSync("/home/sheikh/fb-work/norfold-head-") : null;
  cleanups.push(async () => { for (const handle of handles) await handle.close(); if (dir) rmSync(dir, { recursive: true }); });
  async function open() {
    let history: MessagingHistory;
    if (!dir) history = await openWebMessagingHistory(scope, { indexedDB: factory, mediaBytes });
    else {
      const db = new DatabaseSync(join(dir, "history.sqlite"));
      history = await openSqliteMessagingHistory({
        exec: sql => { db.exec(sql); },
        all: (sql, values = []) => db.prepare(sql).all(...values) as never,
        run: (sql, values = []) => Number(db.prepare(sql).run(...values).changes),
        close: () => db.close(),
      }, scope, { mediaBytes });
    }
    handles.add(history); return history;
  }
  async function close(history: MessagingHistory) { await history.close(); handles.delete(history); }
  return { open, close };
}

describe.each(["IndexedDB", "SQLite"] as const)("%s durable conversation checkpoints", kind => {
  it("starts unknown, survives close/reopen and never becomes portable history", async () => {
    const f = await fixture(kind), history = await f.open();
    expect(await history.getConversationCheckpoint(conversationId)).toBeNull();
    await history.commitConversationCheckpoint(head, null);
    expect(await history.getConversationCheckpoint(conversationId)).toEqual(head);
    expect(JSON.stringify(await history.exportSnapshot())).not.toContain("stream-a");
    await f.close(history);
    const reopened = await f.open();
    expect(await reopened.getConversationCheckpoint(conversationId)).toEqual(head);
  });
  it("cannot let an older concurrent reconciliation overwrite a newer checkpoint", async () => {
    const f = await fixture(kind), history = await f.open();
    await history.commitConversationCheckpoint(head, null);
    const next = { ...head, position: 4, messageHead: 4 };
    const later = { ...head, position: 5, messageHead: 5 };
    const results = await Promise.allSettled([
      history.commitConversationCheckpoint(next, head), history.commitConversationCheckpoint(later, head),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await history.getConversationCheckpoint(conversationId)).toEqual(next);
    await expect(history.commitConversationCheckpoint(head, next)).rejects.toThrow();
    expect(await history.getConversationCheckpoint(conversationId)).toEqual(next);
  });
  it("rejects another account or conversation checkpoint and preserves the old state", async () => {
    const f = await fixture(kind), history = await f.open();
    await history.commitConversationCheckpoint(head, null);
    await expect(history.commitConversationCheckpoint({ ...head, accountId: scope.deviceId }, head)).rejects.toThrow();
    await expect(history.commitConversationCheckpoint({ ...head, conversationId: scope.deviceId }, head)).rejects.toThrow();
    expect(await history.getConversationCheckpoint(conversationId)).toEqual(head);
    expect(await history.getConversationCheckpoint(scope.deviceId)).toBeNull();
  });
  it("refuses malformed progress rather than saving a false proof", async () => {
    const f = await fixture(kind), history = await f.open();
    await expect(history.commitConversationCheckpoint({ ...head, position: 100 }, null)).rejects.toThrow();
    expect(await history.getConversationCheckpoint(conversationId)).toBeNull();
  });
  it("does not let another installation inherit prefix authority from a backup", async () => {
    const f = await fixture(kind), source = await f.open();
    await source.commitConversationCheckpoint(head, null);
    const backup = await source.exportSnapshot();
    const replacement = await fixture(kind), restored = await replacement.open();
    await restored.importSnapshot(backup);
    expect(await restored.getConversationCheckpoint(conversationId)).toBeNull();
  });
  it("accepts a reconciled new relationship but does not silently rebind stale concurrent work", async () => {
    const f = await fixture(kind), history = await f.open();
    await history.commitConversationCheckpoint(head, null);
    const next = { ...head, revision: 2, epoch: "epoch-b" };
    await history.commitConversationCheckpoint(next, head);
    await expect(history.commitConversationCheckpoint({ ...head, position: 4, messageHead: 4 }, head)).rejects.toThrow();
    expect(await history.getConversationCheckpoint(conversationId)).toEqual(next);
  });
  it("refuses checkpoint reads/writes after logical account purge, including reopened handles", async () => {
    const f = await fixture(kind), history = await f.open();
    await history.commitConversationCheckpoint(head, null);
    await history.purgeHistory();
    await expect(history.getConversationCheckpoint(conversationId)).rejects.toThrow();
    await expect(history.commitConversationCheckpoint(head, null)).rejects.toThrow();
    await f.close(history);
    const reopened = await f.open();
    await expect(reopened.getConversationCheckpoint(conversationId)).rejects.toThrow();
  });
  it("persists body-free unavailable outcomes immutably without exporting them as recovered history", async () => {
    const f = await fixture(kind), history = await f.open();
    const value = { accountId: scope.accountId, conversationId, streamId: head.streamId, position: 1,
      sourceId: scope.deviceId, messageId: scope.deviceId, publishedAt: 900 };
    await history.recordConversationUnavailable(value);
    await history.recordConversationUnavailable(value);
    await expect(history.recordConversationUnavailable({ ...value, messageId: conversationId })).rejects.toThrow();
    await expect(history.recordConversationUnavailable({ ...value, accountId: scope.deviceId })).rejects.toThrow();
    expect(await history.listConversationUnavailable(conversationId)).toEqual([value]);
    expect(JSON.stringify(await history.exportSnapshot())).not.toContain("stream-a");
    await f.close(history);
    const reopened = await f.open();
    expect(await reopened.listConversationUnavailable(conversationId)).toEqual([value]);
  });
});
