// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import { createBackup, decodeBackup, encodeBackup } from "./backup";
import type { MessagingHistory } from "./history";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const D = "00000000-0000-4000-8000-000000000003", C = "00000000-0000-4000-8000-000000000004";
const M = "00000000-0000-4000-8000-000000000005", N = "00000000-0000-4000-8000-000000000006";
const scope = { accountId: A, deviceId: D };

describe.each(["web", "android"] as const)("%s durable read knowledge", platform => {
  it("survives reopen, backup and stale replay without importing receipt authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-read-facts-")), factories = new Map<string, IDBFactory>();
    const open = async (name: string): Promise<MessagingHistory> => {
      if (platform === "web") {
        if (!factories.has(name)) factories.set(name, new IDBFactory());
        return openWebMessagingHistory(scope, { indexedDB: factories.get(name)! });
      }
      const db = new DatabaseSync(join(dir, name));
      return openSqliteMessagingHistory({ exec: sql => { db.exec(sql); },
        all: (sql, params = []) => db.prepare(sql).all(...params) as never,
        run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes), close: () => db.close() }, scope);
    };
    const handles: MessagingHistory[] = [];
    try {
      let h = await open("source"); handles.push(h);
      for (const [id, authorId, recipientId, sequence] of [[M, A, B, 1], [N, B, A, 20]] as const) {
        await h.persistInboundAndAck({ ...scope, mailboxId: id, event: { kind: "TEXT", eventId: id, sequence,
          message: { id, conversationId: C, authorId, recipientId, body: "hello", messageType: "TEXT" } } }, async () => {});
      }
      const stale = await h.exportSnapshot();
      await h.saveMessageReadFact(C, [M], "readByPeer");
      await h.markConversationRead(C, 20);
      await h.saveMessageReadFact(C, [N], "receiptObserved");
      await expect(h.saveMessageReadFact(C, [N], "readByPeer")).rejects.toThrow();
      await expect(h.saveMessageReadFact(C, [M], "receiptObserved")).rejects.toThrow();
      await h.close();
      h = await open("source"); handles.push(h);
      expect(await h.getMessage(M)).toMatchObject({ readByPeer: true });
      expect(await h.getMessage(N)).toMatchObject({ readLocally: true, receiptObserved: true });
      // Same deterministic tie-break on both adapters, not platform-local
      // insertion timestamps (which differ across restore/replay/device).
      const pendingIds = ["00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000008"];
      const clock = vi.spyOn(Date, "now");
      try {
        for (const [index, id] of pendingIds.entries()) {
          clock.mockReturnValue(1000 + index);
          await h.enqueueOutgoing({ id, conversationId: C, authorId: A, recipientId: B, body: "pending", messageType: "TEXT" }, "a".repeat(64));
        }
      } finally { clock.mockRestore(); }
      expect((await h.listMessages(C)).map(message => message.id)).toEqual([M, N, ...[...pendingIds].reverse()]);
      const backup = await decodeBackup(encodeBackup(await createBackup(h, scope, 100)));
      const restored = await open("target"); handles.push(restored);
      await restored.importSnapshot(backup.snapshot);
      await restored.importSnapshot(stale);
      expect(await restored.getMessage(M)).toMatchObject({ readByPeer: true });
      expect(await restored.getMessage(N)).toMatchObject({ readLocally: true, receiptObserved: true });
      expect((await restored.listConversations())[0]?.unreadCount).toBe(0);
      expect((await restored.exportSnapshot()).messages).toEqual(backup.snapshot.messages);
      expect(await restored.getConversationCheckpoint(C)).toBeNull();
      // A sparse backup's per-message read facts must not mark missing older
      // bodies as read if another device supplies them later.
      const older = "00000000-0000-4000-8000-000000000007";
      await restored.persistInboundAndAck({ ...scope, mailboxId: older, event: { kind: "TEXT", eventId: older, sequence: 10,
        message: { id: older, conversationId: C, authorId: B, recipientId: A, body: "Not seen before", messageType: "TEXT" } } }, async () => {});
      expect((await restored.listConversations())[0]?.unreadCount).toBe(1);
    } finally {
      await Promise.all(handles.map(h => h.close())); rmSync(dir, { recursive: true, force: true });
    }
  });
});
