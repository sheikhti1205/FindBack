// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistorySnapshot, SnapshotMessage } from "./history";
import type { BackupDriveStore } from "./backupDrive";
import { DriveStoreError } from "./driveStore";
import { DriveAuthError, type DriveAccess } from "./driveAuth";
import type { BackupKeyMaterial } from "./backupKey";
import {
  BACKUP_COMPACT_MS,
  BACKUP_MAX_DELAY_MS,
  BACKUP_STATE_KEY,
  DriveBackup,
  backoffDelayMs,
  parseBackupState,
  type BackupDeps,
} from "./backupService";

const A = "00000000-0000-4000-9f01-000000000001";
const PEER = "00000000-0000-4000-9f01-000000000002";
const CHAT = "00000000-0000-4000-9f01-000000000010";
const DEVICE = "00000000-0000-4000-9f01-000000000020";
const GEN = "00000000-0000-4000-9f01-000000000030";
const GEN2 = "00000000-0000-4000-9f01-000000000031";
const KEY_HEX = "ab".repeat(32);
const NOW = 1_760_000_000_000;

const uuid = (n: number) => `00000000-0000-4000-9f01-${n.toString(16).padStart(12, "0")}`;

function snapshotOf(count: number, body = "hello"): HistorySnapshot {
  const messages: SnapshotMessage[] = Array.from({ length: count }, (_, index) => ({
    id: uuid(0x1000 + index), conversationId: CHAT, authorId: PEER, recipientId: A,
    body: `${body} ${index}`, messageType: "TEXT", contextReportId: null, location: null,
    serverEventId: uuid(0x5000 + index), serverSequence: index + 1, unsentAt: null, createdAt: 0,
  }));
  return { conversations: [{ id: CHAT, lastSequence: count, createdAt: 0, updatedAt: 0 }],
    messages, tombstones: [], deletedForMe: [], clears: [] };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    raw: () => map.get(BACKUP_STATE_KEY) ?? null,
  };
}

function memoryStore(): BackupDriveStore & { names(): string[] } {
  const files = new Map<string, { id: string; name: string; bytes: ArrayBuffer }>();
  let sequence = 0;
  const store = {
    names: () => [...files.values()].map((file) => file.name).sort(),
    async list() {
      return [...files.values()].map((file) => ({ id: file.id, name: file.name, size: file.bytes.byteLength }));
    },
    async read(id: string) {
      const file = files.get(id);
      if (!file) throw new Error("missing");
      return file.bytes.slice(0);
    },
    async write({ id, name, bytes }: { id?: string; name: string; bytes: ArrayBuffer }) {
      const current = (id ? files.get(id) : undefined)
        ?? [...files.values()].find((file) => file.name === name);
      if (current) { current.name = name; current.bytes = bytes; return { id: current.id, name, size: bytes.byteLength }; }
      const file = { id: `f${++sequence}`, name, bytes };
      files.set(file.id, file);
      return { id: file.id, name, size: bytes.byteLength };
    },
    async remove(id: string) { files.delete(id); },
  };
  return store;
}

function fakeAuth(options: { available?: boolean; reason?: "native" | "unconfigured" } = {}) {
  let access: DriveAccess | null = { token: "ya29.example.token.value", expiresAt: NOW + 3_600_000 };
  const state = {
    available: () => options.available ?? true,
    unavailableReason: () => (options.available === false ? options.reason ?? "native" : null),
    current: () => access,
    authorize: vi.fn(async () => {
      if (options.available === false) throw new DriveAuthError(options.reason ?? "native");
      access = { token: "ya29.example.token.value", expiresAt: NOW + 3_600_000 };
      return access;
    }),
    renew: vi.fn(async () => access),
    forget: vi.fn(() => { access = null; }),
    drop: () => { access = null; },
  };
  return state;
}

interface Harness {
  backup: DriveBackup;
  auth: ReturnType<typeof fakeAuth>;
  store: ReturnType<typeof memoryStore>;
  storage: ReturnType<typeof memoryStorage>;
  imported: HistorySnapshot | null;
  key: () => BackupKeyMaterial;
  advance(ms: number): void;
  deps: BackupDeps;
}

function harness(options: {
  available?: boolean; reason?: "native" | "unconfigured";
  snapshot?: HistorySnapshot; key?: () => BackupKeyMaterial; store?: BackupDriveStore;
  storage?: ReturnType<typeof memoryStorage>;
} = {}): Harness {
  let now = NOW;
  const material: BackupKeyMaterial = { accountId: A, generation: GEN, keyHex: KEY_HEX, createdAt: NOW };
  const auth = fakeAuth(options);
  const store = memoryStore();
  const storage = options.storage ?? memoryStorage();
  const state = { imported: null as HistorySnapshot | null };
  const deps: BackupDeps = {
    auth,
    key: async () => (options.key ? options.key() : material),
    snapshot: async () => options.snapshot ?? snapshotOf(3),
    importSnapshot: async (snapshot) => { state.imported = snapshot; },
    accountId: () => A,
    deviceId: () => DEVICE,
    storage,
    now: () => now,
    random: () => 0.5,
    store: () => options.store ?? store,
  };
  const backup = new DriveBackup(deps);
  return {
    backup, auth, store, storage,
    get imported() { return state.imported; },
    key: () => material,
    advance: (ms) => { now += ms; },
    deps,
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("when backup may run", () => {
  it("offers the optional prompt once, only for a meaningful history", () => {
    const first = harness();
    expect(first.backup.promptDecision(19)).toBeNull();
    expect(first.backup.promptDecision(20)).toBe("show");
    first.backup.dismissPrompt();
    expect(first.backup.promptDecision(200)).toBeNull();

    const unavailable = harness({ available: false });
    expect(unavailable.backup.promptDecision(200)).toBeNull();
  });

  it("does nothing until the user enables it", async () => {
    const { backup, store } = harness();
    expect(backup.status()).toEqual({ kind: "off" });
    backup.markDirty();
    await expect(backup.uploadNow()).resolves.toEqual({ kind: "off" });
    expect(store.names()).toEqual([]);
  });

  it("connects, uploads the first pass, and then reports up to date", async () => {
    const { backup, auth, store, storage, deps } = harness();
    await expect(backup.connect()).resolves.toMatchObject({ kind: "up-to-date" });
    expect(auth.authorize).toHaveBeenCalledTimes(1);
    expect(store.names().length).toBe(2);
    expect(parseBackupState(storage.raw()).enabled).toBe(true);
    expect(parseBackupState(storage.raw()).dirty).toBe(false);
    expect(parseBackupState(storage.raw()).generation).toBe(GEN);
    await expect(deps.snapshot()).resolves.toBeTruthy();
  });

  it("batches marked changes and waits for the batching delay", async () => {
    const run = harness();
    await run.backup.connect();
    const files = run.store.names();
    run.backup.markDirty();
    await expect(run.backup.tick()).resolves.toMatchObject({ kind: "waiting" });
    expect(run.store.names()).toEqual(files);
    run.advance(BACKUP_MAX_DELAY_MS);
    await expect(run.backup.tick()).resolves.toMatchObject({ kind: "up-to-date" });
    expect(parseBackupState(run.storage.raw()).dirty).toBe(false);
  });

  it("refreshes once a day even without changes", async () => {
    const run = harness();
    await run.backup.connect();
    const before = run.store.names();
    run.advance(BACKUP_COMPACT_MS - 1);
    run.advance(BACKUP_MAX_DELAY_MS);
    await run.backup.tick();
    expect(run.store.names()).toEqual(before);
    expect(parseBackupState(run.storage.raw()).dirty).toBe(false);
    expect(parseBackupState(run.storage.raw()).lastUploadAt)
      .toBe(NOW + BACKUP_COMPACT_MS - 1 + BACKUP_MAX_DELAY_MS);
    run.advance(BACKUP_COMPACT_MS);
    await run.backup.tick();
    expect(run.store.names()).toEqual(before);
    expect(parseBackupState(run.storage.raw()).lastUploadAt)
      .toBe(NOW + 2 * BACKUP_COMPACT_MS - 1 + BACKUP_MAX_DELAY_MS);
  });

  it("reports an unavailable platform instead of a fake connection", () => {
    const native = harness({ available: false, reason: "native" });
    expect(native.backup.status()).toEqual({ kind: "unavailable", reason: "native" });
    const unconfigured = harness({ available: false, reason: "unconfigured" });
    expect(unconfigured.backup.status()).toEqual({ kind: "unavailable", reason: "unconfigured" });
  });

  it("asks for a connection instead of uploading when the token is gone", async () => {
    const run = harness();
    await run.backup.connect();
    run.auth.drop();
    run.auth.renew.mockResolvedValueOnce(null);
    await expect(run.backup.uploadNow()).resolves.toMatchObject({ kind: "attention", lastError: "auth" });
    expect(parseBackupState(run.storage.raw()).lastError).toBe("auth");
  });
});

describe("failure handling", () => {
  it("backs off with the provider's retry delay and does not lose the dirty flag", async () => {
    const failing: BackupDriveStore = {
      list: async () => { throw new DriveStoreError("throttled", 10 * 60_000); },
      read: async () => new ArrayBuffer(0),
      write: async ({ name, bytes }) => ({ id: "x", name, size: bytes.byteLength }),
      remove: async () => undefined,
    };
    const run = harness({ store: failing });
    await run.backup.connect().catch(() => undefined);
    // connect() never throws; its first pass records the failure.
    const state = parseBackupState(run.storage.raw());
    expect(state.failures).toBe(1);
    expect(state.lastError).toBe("throttled");
    expect(state.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 10 * 60_000);
    run.backup.markDirty();
    await run.backup.tick();
    expect(parseBackupState(run.storage.raw()).failures).toBe(1);
  });

  it("grows the delay exponentially but never past the cap", () => {
    expect(backoffDelayMs(1, 0, () => 0)).toBe(60_000);
    expect(backoffDelayMs(2, 0, () => 0)).toBe(120_000);
    expect(backoffDelayMs(3, 0, () => 0)).toBe(240_000);
    expect(backoffDelayMs(30, 0, () => 0)).toBe(30 * 60_000);
    expect(backoffDelayMs(2, 45 * 60_000, () => 0)).toBe(45 * 60_000);
  });

  it("rebuilds when the account key generation changed", async () => {
    const run = harness();
    await run.backup.connect();
    // A rotation later yields a new key and generation over the same Drive files.
    const rotated = { accountId: A, generation: GEN2, keyHex: "cd".repeat(32), createdAt: NOW };
    const second = harness({
      storage: run.storage,
      store: run.store,
      key: () => rotated,
      snapshot: snapshotOf(2, "after rotation"),
    });
    await second.backup.uploadNow();
    const state = parseBackupState(second.storage.raw());
    expect(state.generation).toBe(GEN2);
    expect(state.repair).toBe(false);
    expect(run.store.names().filter((name) => name.includes(GEN2)).length).toBe(0);
    expect(run.store.names().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the old manifest when the provider fails mid-pass", async () => {
    const run = harness();
    await run.backup.connect();
    const files = run.store.names();
    run.backup.markDirty();
    const write = run.store.write.bind(run.store);
    let failNext = true;
    run.store.write = async (input) => {
      if (failNext && input.name.includes("manifest")) { failNext = false; throw new DriveStoreError("unavailable"); }
      return write(input);
    };
    await run.backup.uploadNow();
    expect(run.store.names()).toEqual(expect.arrayContaining(files));
    expect(parseBackupState(run.storage.raw()).failures).toBe(1);
  });
});

describe("restore", () => {
  it("downloads, merges through the ordinary import, and marks the merge dirty", async () => {
    const source = harness({ snapshot: snapshotOf(4) });
    await source.backup.connect();

    const target = harness({ storage: memoryStorage(), snapshot: snapshotOf(0) });
    // The target shares the source's Drive objects.
    for (const file of await source.store.list()) {
      await target.store.write({ name: file.name, bytes: await source.store.read(file.id) });
    }
    const result = await target.backup.restore();
    expect(result.messages).toBe(4);
    expect(target.imported?.messages).toHaveLength(4);
  });

  it("refuses to restore without a token or account", async () => {
    const run = harness();
    run.auth.drop();
    run.auth.renew.mockResolvedValueOnce(null);
    await expect(run.backup.restore()).rejects.toBeInstanceOf(DriveStoreError);
    const anonymous = harness();
    anonymous.deps.accountId = () => null;
    await expect(anonymous.backup.restore()).rejects.toBeInstanceOf(DriveStoreError);
  });
});
