// @vitest-environment node
/** Real backup owner/crypto and IndexedDB import. Runtime admission and Drive
 * objects are synthetic ports; this is not real-account/native acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openWebMessagingHistory } from "./indexedDbHistory";
import type { HistorySnapshot, MessagingHistory } from "./history";
import type { BackupDriveStore } from "./backupDrive";
import { backupStateKey, parseBackupState } from "./backupService";

const f = vi.hoisted(() => ({ account: "", generation: 0, revision: 0,
  listeners: new Set<() => void>(), histories: new Map<string, MessagingHistory>(),
  store: null as BackupDriveStore | null,
  exportGate: null as Promise<void> | null, exportEntered: () => {},
}));
const A = "00000000-0000-4000-9903-000000000001", B = "00000000-0000-4000-9903-000000000002";
const DEVICE = "00000000-0000-4000-9903-000000000003", GEN = "00000000-0000-4000-9903-000000000004";
const CHAT = "00000000-0000-4000-9903-000000000010";
vi.mock("./runtime", () => ({
  getMessagingRuntimeSnapshot: () => ({ accountId: f.account || null, status: f.account ? "ready" : "closed", revision: f.revision }),
  getMessagingRuntimeGeneration: () => f.generation,
  webInstallationId: () => "00000000-0000-4000-9903-000000000003",
  subscribeMessagingRuntime: (listener: () => void) => { f.listeners.add(listener); return () => f.listeners.delete(listener); },
  exportMessagingSnapshot: async (accountId: string) => {
    f.exportEntered(); if (f.exportGate) await f.exportGate;
    return f.histories.get(accountId)!.exportSnapshot();
  },
  importMessagingSnapshot: async (accountId: string, snapshot: HistorySnapshot) => f.histories.get(accountId)!.importSnapshot(snapshot),
}));
vi.mock("./backupKey", () => ({ readBackupKey: async () => ({ accountId: f.account,
  generation: "00000000-0000-4000-9903-000000000004", keyHex: "ab".repeat(32), createdAt: 1 }) }));
vi.mock("./driveAuth", () => ({ driveAuth: () => ({ generation: () => 0, available: () => true,
  unavailableReason: () => null, current: () => ({ token: "synthetic-grant", expiresAt: Date.now() + 3_600_000 }),
  authorize: async () => ({ token: "synthetic-grant", expiresAt: Date.now() + 3_600_000 }), renew: async () => null, forget: () => {},
}) }));
vi.mock("./driveStore", async original => ({ ...await original<typeof import("./driveStore")>(),
  DriveRestStore: class { constructor() { return f.store!; } },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let owner: typeof import("./backupRuntime"), storage: Map<string, string>;
beforeEach(async () => {
  vi.resetModules(); f.account = A; f.generation = 0; f.revision = 0;
  f.listeners.clear(); f.histories.clear(); f.exportGate = null; f.exportEntered = () => {};
  storage = new Map(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  const files = new Map<string, { id: string; name: string; bytes: ArrayBuffer }>(); let sequence = 0;
  f.store = {
    list: async () => [...files.values()].map(row => ({ id: row.id, name: row.name, size: row.bytes.byteLength })),
    read: async id => files.get(id)!.bytes.slice(0),
    write: async input => { const row = { ...input, id: input.id ?? String(++sequence) };
      files.set(row.id, row); return { id: row.id, name: row.name, size: row.bytes.byteLength }; },
    remove: async id => { files.delete(id); },
  };
  const indexedDB = new IDBFactory();
  for (const accountId of [A, B]) f.histories.set(accountId, await openWebMessagingHistory({ accountId, deviceId: DEVICE }, { indexedDB }));
  await f.histories.get(A)!.importSnapshot({ conversations: [{ id: CHAT, lastSequence: 1, createdAt: 0, updatedAt: 0 }],
    messages: [{ id: GEN, conversationId: CHAT, authorId: B, recipientId: A, body: "synthetic saved message",
      messageType: "TEXT", contextReportId: null, location: null, serverEventId: DEVICE,
      serverSequence: 1, unsentAt: null, createdAt: 0 }], clears: [], deletedForMe: [], tombstones: [] });
  owner = await import("./backupRuntime");
});
afterEach(async () => {
  owner.clearDriveBackup();
  await Promise.all([...f.histories.values()].map(history => history.close()));
  vi.unstubAllGlobals(); vi.useRealTimers();
});
function publish() { for (const listener of f.listeners) listener(); }

describe("runtime-scoped backup", () => {
  it("shares scheduling until the last foreground subscriber leaves", async () => {
    vi.useFakeTimers();
    const backup = owner.driveBackup(), tick = vi.spyOn(backup, "tick");
    const first = owner.startDriveBackup(), second = owner.startDriveBackup();
    expect(vi.getTimerCount()).toBe(1);
    first(); await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    second(); expect(vi.getTimerCount()).toBe(0);
  });

  it("retains one writer across cleanup until an old request settles", async () => {
    const backup = owner.driveBackup(); await backup.connect();
    const entered = deferred(), release = deferred(), write = f.store!.write;
    f.store!.write = async input => {
      if (input.name.includes("manifest")) { entered.resolve(); await release.promise; }
      return write(input);
    };
    const pending = backup.uploadNow(); await entered.promise;
    owner.clearDriveBackup(); f.generation++;
    const reopened = owner.driveBackup();
    const next = reopened.connect();
    // No second grant, snapshot or writer is admitted during settlement.
    expect(reopened.status().kind).toBe("stopping");
    expect(await next).toEqual({ kind: "skipped", reason: "not-ready" });
    release.resolve(); expect(await pending).toEqual({ kind: "skipped", reason: "superseded" });
    expect((await reopened.connect()).kind).toBe("committed");
  });

  it("fences a same-account session replacement during real IndexedDB export", async () => {
    const backup = owner.driveBackup(); await backup.connect(); backup.markDirty();
    const entered = deferred(), release = deferred(); f.exportEntered = entered.resolve; f.exportGate = release.promise;
    const pending = backup.uploadNow(); await entered.promise;
    f.generation++; publish(); release.resolve();
    expect(await pending).toEqual({ kind: "skipped", reason: "superseded" });
    expect((await f.histories.get(A)!.exportSnapshot()).messages).toHaveLength(1);
    expect((await f.histories.get(B)!.exportSnapshot()).messages).toHaveLength(0);
  });

  it("tracks changed history even with no mounted Chat or scheduler", async () => {
    const backup = owner.driveBackup(); await backup.connect();
    f.revision++; publish();
    const state = parseBackupState(storage.get(backupStateKey(A)));
    expect(state.dirtyRevision).toBeGreaterThan(state.uploadedRevision);
  });

  it("does not make transient runtime notifications dirty without a history revision", async () => {
    const backup = owner.driveBackup(); await backup.connect(); publish();
    const state = parseBackupState(storage.get(backupStateKey(A)));
    expect(state.dirtyRevision).toBe(state.uploadedRevision);
  });
});
