// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistorySnapshot, SnapshotMessage } from "./history";
import type { BackupDriveStore } from "./backupDrive";
import { downloadBackup } from "./backupDrive";
import { importBackupKey } from "./backupCrypto";
import { DriveStoreError } from "./driveStore";
import { DriveAuthError, type DriveAccess } from "./driveAuth";
import type { BackupKeyMaterial } from "./backupKey";
import { ApiError } from "../session";
import {
  BACKUP_COMPACT_MS,
  BACKUP_MAX_DELAY_MS,
  BACKUP_STATE_KEY,
  backupStateKey,
  DriveBackup,
  backoffDelayMs,
  parseBackupState,
  type BackupDeps,
  type BackupLease,
} from "./backupService";

const A = "00000000-0000-4000-9f01-000000000001";
const B = "00000000-0000-4000-9f01-000000000003";
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
    raw: (accountId = A) => map.get(backupStateKey(accountId)) ?? null,
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
  let generation = 0;
  const state = {
    generation: () => generation,
    available: () => options.available ?? true,
    unavailableReason: () => (options.available === false ? options.reason ?? "native" : null),
    current: () => access,
    authorize: vi.fn(async () => {
      if (options.available === false) throw new DriveAuthError(options.reason ?? "native");
      access = { token: "ya29.example.token.value", expiresAt: NOW + 3_600_000 };
      return access;
    }),
    renew: vi.fn(async () => access),
    invalidate: vi.fn(async (token: string) => { if (access?.token === token) access = null; }),
    forget: vi.fn(() => { generation++; access = null; }),
    drop: () => { access = null; },
  };
  return state;
}

describe("safe backup failure diagnosis", () => {
  it("does not mislabel a rejected Drive contract as an offline connection", async () => {
    const store = memoryStore();
    store.list = async () => { throw new DriveStoreError("invalid", 0, 403, "api-disabled"); };
    const h = harness({ store });
    await expect(h.backup.connect()).resolves.toEqual({ kind: "failed", reason: "provider" });
    expect(h.backup.status()).toMatchObject({
      diagnostic: { stage: "drive-list", cause: "invalid", httpStatus: 403, providerReason: "api-disabled" },
    });
  });

  it("identifies server-key failure without exposing the RPC message or arguments", async () => {
    const h = harness({ key: () => { throw new ApiError("PRIVATE_DIAGNOSTIC_SENTINEL", 500); } });
    await expect(h.backup.connect()).resolves.toEqual({ kind: "failed", reason: "other" });
    expect(h.backup.status()).toMatchObject({ diagnostic: { stage: "account-key", cause: "server" } });
    expect(JSON.stringify(h.backup.status())).not.toContain("PRIVATE_DIAGNOSTIC_SENTINEL");
    expect(JSON.stringify(h.backup.status())).not.toContain(KEY_HEX);
  });

  it("clears the prior failure diagnosis after a successful pass", async () => {
    let fail = true;
    const h = harness({ key: () => {
      if (fail) throw new ApiError("synthetic", 500);
      return { accountId: A, generation: GEN, keyHex: KEY_HEX, createdAt: NOW };
    } });
    await h.backup.connect();
    expect(h.backup.status()).toHaveProperty("diagnostic");
    fail = false;
    expect((await h.backup.uploadNow()).kind).toBe("committed");
    expect(h.backup.status()).not.toHaveProperty("diagnostic");
  });
});

interface Harness {
  backup: DriveBackup;
  auth: ReturnType<typeof fakeAuth>;
  store: ReturnType<typeof memoryStore>;
  storage: ReturnType<typeof memoryStorage>;
  imported: HistorySnapshot | null;
  key: () => BackupKeyMaterial;
  advance(ms: number): void;
  deps: BackupDeps;
  switchAccount(accountId: string | null): void;
  switchSession(): void;
}

function harness(options: {
  available?: boolean; reason?: "native" | "unconfigured";
  snapshot?: HistorySnapshot; key?: () => BackupKeyMaterial; store?: BackupDriveStore;
  storage?: ReturnType<typeof memoryStorage>;
  accountId?: string;
} = {}): Harness {
  let now = NOW;
  const material: BackupKeyMaterial = { accountId: A, generation: GEN, keyHex: KEY_HEX, createdAt: NOW };
  const auth = fakeAuth(options);
  const store = memoryStore();
  const storage = options.storage ?? memoryStorage();
  const state = { imported: null as HistorySnapshot | null };
  let accountId: string | null = options.accountId ?? A, sessionGeneration = 0;
  const deps: BackupDeps = {
    auth,
    key: async () => (options.key ? options.key() : material),
    snapshot: async () => options.snapshot ?? snapshotOf(3),
    importSnapshot: async (_lease, snapshot) => { state.imported = snapshot; },
    captureLease: () => accountId ? Object.freeze({ accountId, deviceId: DEVICE,
      sessionGeneration, driveGeneration: auth.generation(), operationGeneration: 0 }) : null,
    isCurrent: (lease: BackupLease) => lease.accountId === accountId
      && lease.sessionGeneration === sessionGeneration && lease.driveGeneration === auth.generation(),
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
    switchAccount: next => { accountId = next; sessionGeneration++; },
    switchSession: () => { sessionGeneration++; },
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("operation ownership", () => {
  it("restores older Drive history before committing a reconnect with an incomplete local copy", async () => {
    const run = harness({ snapshot: snapshotOf(25) });
    await run.backup.connect();
    let local = snapshotOf(3);
    let restoredCount = 0;
    run.deps.snapshot = async () => local;
    run.deps.importSnapshot = async (_lease, restored) => { restoredCount = restored.messages.length; local = restored; };
    run.auth.drop();
    const outcome = await run.backup.connect();
    expect(outcome.kind).toBe("committed");
    expect(restoredCount).toBe(25);
    expect(local.messages).toHaveLength(25);
    const recovered = await downloadBackup({ store: run.store, key: await importBackupKey(GEN, KEY_HEX),
      scope: { accountId: A, deviceId: DEVICE } });
    expect(recovered.snapshot.messages).toHaveLength(25);
  });

  it("reuses a valid connection when enabling backup instead of requesting Google again", async () => {
    const run = harness();
    await run.backup.connect();
    expect(run.auth.authorize).not.toHaveBeenCalled();
    run.backup.disable();
    await run.backup.connect();
    expect(run.auth.authorize).not.toHaveBeenCalled();
  });

  it("tries renewal before telling an enabled cold-start backup to reconnect", async () => {
    const run = harness(); await run.backup.connect();
    run.auth.drop();
    expect(run.backup.status().kind).toBe("waiting");
    run.advance(BACKUP_MAX_DELAY_MS); run.backup.markDirty();
    expect((await run.backup.tick()).kind).toBe("needs-connection");
    expect(run.auth.renew).toHaveBeenCalledTimes(1);
    expect(run.backup.status().kind).toBe("needs-connection");
  });

  it("silently renews and restores on a fresh runtime before uploading", async () => {
    const run = harness({ snapshot: snapshotOf(25) });
    await run.backup.connect();
    const access = run.auth.current();
    let local = snapshotOf(3);
    run.deps.snapshot = async () => local;
    run.deps.importSnapshot = async (_lease, restored) => { local = restored; };
    run.auth.drop();
    run.auth.renew.mockImplementation(async () => { run.auth.current = () => access; return access; });
    const reopened = new DriveBackup(run.deps);
    run.advance(BACKUP_MAX_DELAY_MS);
    expect((await reopened.tick()).kind).toBe("committed");
    expect(local.messages).toHaveLength(25);
    expect(run.auth.renew).toHaveBeenCalledTimes(1);
    expect(run.auth.authorize).not.toHaveBeenCalled();
  });

  it("preserves the committed backup and asks for repair when the key generation changes", async () => {
    const run = harness(); await run.backup.connect();
    const manifest = (await run.store.list()).find(file => file.name.includes("manifest"))!;
    const before = new Uint8Array(await run.store.read(manifest.id)), names = run.store.names();

    run.deps.key = async () => ({ accountId: A, generation: GEN2, keyHex: KEY_HEX, createdAt: NOW });
    run.backup.markDirty();
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "failed", reason: "integrity" });
    expect(new Uint8Array(await run.store.read(manifest.id))).toEqual(before);
    expect(run.store.names()).toEqual(names);
    expect(run.backup.status()).toMatchObject({ kind: "attention", lastError: "integrity" });
  });

  it("keeps the committed backup when this device reports no history", async () => {
    const run = harness(); await run.backup.connect();
    const manifest = (await run.store.list()).find(file => file.name.includes("manifest"))!;
    const before = new Uint8Array(await run.store.read(manifest.id)), names = run.store.names();

    // A failed local database open must not erase the only restorable copy.
    run.deps.snapshot = async () => ({ conversations: [], messages: [],
      tombstones: [], deletedForMe: [], clears: [] });
    run.backup.markDirty();
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "failed", reason: "snapshot" });
    expect(new Uint8Array(await run.store.read(manifest.id))).toEqual(before);
    expect(run.store.names()).toEqual(names);
    const state = parseBackupState(run.storage.raw());
    expect(state.dirtyRevision).toBeGreaterThan(state.uploadedRevision);
    expect(state.lastError).toBe("snapshot");
    expect(run.backup.status()).toMatchObject({ kind: "attention", lastError: "snapshot" });
  });

  it("names a removed installation instead of asking for a connection retry", async () => {
    const run = harness(); await run.backup.connect();
    run.deps.key = async () => {
      throw new ApiError("This device was removed from your account. Sign in again to use Chat.", 403, "42501");
    };
    run.backup.markDirty();
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "failed", reason: "account" });
    expect(run.backup.status()).toMatchObject({ kind: "attention", lastError: "account" });
    expect(parseBackupState(run.storage.raw()).dirtyRevision)
      .toBeGreaterThan(parseBackupState(run.storage.raw()).uploadedRevision);
  });

  it("does not claim an opt-out that the policy store refused", async () => {
    const run = harness(); await run.backup.connect();
    const setItem = run.storage.setItem;
    run.storage.setItem = () => { throw new Error("quota"); };
    const disabled = run.backup.disable();
    // The durable policy still enables backup, so the surface must not say off.
    expect(run.backup.status()).toMatchObject({ kind: "attention", lastError: "storage" });
    expect(run.backup.status().enabled).toBe(true);
    expect(parseBackupState(run.storage.raw()).enabled).toBe(true);
    run.storage.setItem = setItem;
    const writes = vi.spyOn(run.store, "write");
    run.backup.markDirty(); run.advance(BACKUP_COMPACT_MS + 1);
    await expect(run.backup.tick()).resolves.toEqual({ kind: "skipped", reason: "off" });
    expect(disabled).toBe(false);
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "skipped", reason: "off" });
    expect(writes).not.toHaveBeenCalled();
    expect(run.backup.status()).toMatchObject({ enabled: true, optOutPending: true });
    expect(run.backup.disable()).toBe(true);
    expect(run.backup.status()).toMatchObject({ kind: "off", enabled: false });
    expect(parseBackupState(run.storage.raw()).enabled).toBe(false);
  });

  it("only explicit successful reconnect releases a failed-opt-out upload veto", async () => {
    const run = harness(); await run.backup.connect();
    const setItem = run.storage.setItem;
    run.storage.setItem = () => { throw new Error("quota"); };
    run.backup.disable();
    await expect(run.backup.connect()).resolves.toEqual({ kind: "failed", reason: "storage" });
    run.storage.setItem = setItem;
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "skipped", reason: "off" });
    await expect(run.backup.connect()).resolves.toMatchObject({ kind: "committed" });
    expect(run.backup.status()).not.toHaveProperty("optOutPending");
  });

  it("reads a disabled policy as off even with a stale storage warning", async () => {
    const run = harness(); await run.backup.connect();
    run.backup.disable();
    run.storage.setItem = () => { throw new Error("quota"); };
    run.backup.markDirty();
    expect(run.backup.status()).toMatchObject({ kind: "off", enabled: false });
  });

  it("records the commit even when post-publication cleanup fails", async () => {
    const run = harness(); await run.backup.connect();
    run.store.remove = async () => { throw new Error("cleanup refused"); };
    run.deps.snapshot = async () => snapshotOf(4, "changed");
    run.backup.markDirty();
    await expect(run.backup.uploadNow()).resolves.toMatchObject({ kind: "committed" });
    const state = parseBackupState(run.storage.raw());
    expect(state.lastUploadAt).toBe(NOW);
    expect(state.dirtyRevision).toBe(state.uploadedRevision);
    expect(run.backup.status().kind).toBe("up-to-date");
  });

  it.each(["session", "logout", "drive"])("revokes %s work before a delayed key can publish", async change => {
    const run = harness(); await run.backup.connect(); run.backup.markDirty();
    const entered = deferred(), release = deferred();
    run.deps.key = async () => { entered.resolve(); await release.promise; return run.key(); };
    const pending = run.backup.uploadNow(); await entered.promise;
    if (change === "session") run.switchSession();
    if (change === "logout") run.switchAccount(null);
    if (change === "drive") run.auth.forget();
    release.resolve(); expect(await pending).toEqual({ kind: "skipped", reason: "superseded" });
    const state = parseBackupState(run.storage.raw());
    expect(state.dirtyRevision).toBeGreaterThan(state.uploadedRevision);
    expect(state.failures).toBe(0);
  });

  it("reports stopping until a dispatched manifest write settles and never records stale success", async () => {
    const run = harness(); await run.backup.connect(); run.backup.markDirty(); run.advance(1000);
    const entered = deferred(), release = deferred(), write = run.store.write.bind(run.store);
    const statuses: string[] = [], stop = run.backup.subscribe(() => statuses.push(run.backup.status().kind));
    run.store.write = async input => {
      if (input.name.includes("manifest")) { entered.resolve(); await release.promise; }
      return write(input);
    };
    const pending = run.backup.uploadNow(); await entered.promise;
    run.backup.disable(); expect(run.backup.status().kind).toBe("stopping");
    await expect(run.backup.restore()).resolves.toEqual({ kind: "skipped", reason: "not-ready" });
    release.resolve(); expect(await pending).toEqual({ kind: "skipped", reason: "superseded" });
    expect(run.backup.status().kind).toBe("off"); expect(statuses).toContain("stopping");
    expect(parseBackupState(run.storage.raw()).lastUploadAt).toBe(NOW); stop();
  });

  it("fails opt-in when durable policy storage is absent", async () => {
    const run = harness(), backup = new DriveBackup({ ...run.deps, storage: null });
    await expect(backup.connect()).resolves.toEqual({ kind: "failed", reason: "storage" });
    expect(run.store.names()).toEqual([]);
  });

  it("refuses transport when a dirty policy revision cannot be saved", async () => {
    const run = harness(); await run.backup.connect();
    const files = await run.store.list(), manifest = files.find(f => f.name.includes("manifest"))!;
    const before = new Uint8Array(await run.store.read(manifest.id));
    run.storage.setItem = () => { throw new Error("synthetic quota"); };
    run.backup.markDirty();
    await expect(run.backup.uploadNow()).resolves.toEqual({ kind: "failed", reason: "storage" });
    expect(new Uint8Array(await run.store.read(manifest.id))).toEqual(before);
  });

  it("migrates an ambiguous global policy to disabled without transferring its success", () => {
    const run = harness();
    run.storage.setItem(BACKUP_STATE_KEY, JSON.stringify({ enabled: true, prompted: true, dirty: false, lastUploadAt: NOW }));
    expect(new DriveBackup(run.deps).status()).toEqual({ kind: "off", enabled: false });
  });

  it("treats a restart after committed upload as uncertain changed history", async () => {
    const run = harness(); await run.backup.connect();
    const reloaded = new DriveBackup(run.deps);
    expect(reloaded.status().kind).toBe("waiting");
    await expect(reloaded.uploadNow()).resolves.toMatchObject({ kind: "committed" });
  });

  it("coalesces timer and manual passes into one manifest writer", async () => {
    const run = harness();
    await run.backup.connect();
    run.backup.markDirty(); run.advance(BACKUP_MAX_DELAY_MS);
    const entered = deferred(), release = deferred();
    const list = run.store.list.bind(run.store), write = run.store.write.bind(run.store);
    let lists = 0, manifests = 0;
    run.store.list = async () => {
      if (++lists === 1) { entered.resolve(); await release.promise; }
      return list();
    };
    run.store.write = async input => {
      if (input.name.includes("manifest")) manifests++;
      return write(input);
    };
    const manual = run.backup.uploadNow(); await entered.promise;
    const timer = run.backup.tick(); release.resolve();
    await Promise.all([manual, timer]);
    expect(manifests).toBe(1);
  });

  it.each(["snapshot", "transport"])("keeps changes made while %s is awaiting", async boundary => {
    const run = harness(); await run.backup.connect(); run.backup.markDirty();
    const entered = deferred(), release = deferred();
    if (boundary === "snapshot") {
      const snapshot = run.deps.snapshot;
      run.deps.snapshot = async lease => { entered.resolve(); await release.promise; return snapshot(lease); };
    } else {
      const list = run.store.list.bind(run.store);
      run.store.list = async () => { entered.resolve(); await release.promise; return list(); };
    }
    const pass = run.backup.uploadNow(); await entered.promise;
    run.backup.markDirty(); release.resolve(); await pass;
    const state = parseBackupState(run.storage.raw());
    expect(state.dirtyRevision).toBeGreaterThan(state.uploadedRevision);
  });

  it.each(["key", "snapshot", "list", "chunk"])("disable at %s prevents later publication", async boundary => {
    const run = harness(); await run.backup.connect();
    const oldFiles = await run.store.list();
    const oldManifest = oldFiles.find(f => f.name.includes("manifest"))!;
    const oldBytes = await run.store.read(oldManifest.id);
    run.deps.snapshot = async () => snapshotOf(4, "changed"); run.backup.markDirty();
    const entered = deferred(), release = deferred();
    if (boundary === "key") {
      run.deps.key = async () => { entered.resolve(); await release.promise; return run.key(); };
    } else if (boundary === "snapshot") {
      run.deps.snapshot = async () => { entered.resolve(); await release.promise; return snapshotOf(4); };
    } else if (boundary === "list") {
      const list = run.store.list.bind(run.store);
      run.store.list = async () => { entered.resolve(); await release.promise; return list(); };
    } else {
      const write = run.store.write.bind(run.store);
      run.store.write = async input => {
        if (input.name.includes("chunk")) { entered.resolve(); await release.promise; }
        return write(input);
      };
    }
    const pass = run.backup.uploadNow(); await entered.promise;
    run.backup.disable(); release.resolve(); await pass;
    expect(new Uint8Array(await run.store.read(oldManifest.id))).toEqual(new Uint8Array(oldBytes));
    expect(run.backup.status()).toMatchObject({ kind: "off" });
    expect(parseBackupState(run.storage.raw()).lastUploadAt).toBe(NOW);
  });

  it("disconnect during consent cannot re-enable backup when the grant arrives late", async () => {
    const run = harness(), consent = deferred<DriveAccess>();
    run.auth.authorize.mockImplementationOnce(() => consent.promise);
    const pending = run.backup.connect(); run.backup.forget();
    consent.resolve({ token: "synthetic-grant-token", expiresAt: NOW + 3_600_000 });
    await pending;
    expect(run.store.names()).toEqual([]);
    expect(run.backup.status()).toEqual({ kind: "off", enabled: false });
    expect(parseBackupState(run.storage.raw()).enabled).toBe(false);
  });

  it("account switch during export cannot publish or clear the old account dirty state", async () => {
    const run = harness(); await run.backup.connect(); run.backup.markDirty();
    const entered = deferred(), release = deferred();
    run.deps.snapshot = async () => { entered.resolve(); await release.promise; return snapshotOf(4); };
    const files = await run.store.list(), manifest = files.find(f => f.name.includes("manifest"))!;
    const bytes = await run.store.read(manifest.id);
    const pending = run.backup.uploadNow(); await entered.promise;
    run.switchAccount(B); release.resolve(); await pending;
    expect(new Uint8Array(await run.store.read(manifest.id))).toEqual(new Uint8Array(bytes));
    const state = parseBackupState(run.storage.raw());
    expect(state.dirtyRevision).toBeGreaterThan(state.uploadedRevision);
  });

  it("restore cannot dispatch an import after account switch during download", async () => {
    const run = harness(); await run.backup.connect();
    const entered = deferred(), release = deferred(), read = run.store.read.bind(run.store);
    run.store.read = async id => { entered.resolve(); await release.promise; return read(id); };
    const pending = run.backup.restore(); await entered.promise;
    run.switchAccount(B); release.resolve();
    await pending.catch(() => undefined);
    expect(run.imported).toBeNull();
  });

  it("never calls transport with another account's backup key", async () => {
    const run = harness({ key: () => ({ accountId: B, generation: GEN, keyHex: KEY_HEX, createdAt: NOW }) });
    await run.backup.connect();
    expect(run.store.names()).toEqual([]);
  });

  it("waits for renewal rather than claiming a historical successful upload is currently connected", async () => {
    const run = harness(); await run.backup.connect(); run.auth.drop();
    expect(run.backup.status().kind).toBe("waiting");
  });

  it("does not inherit another account's opt-in policy", async () => {
    const run = harness(); await run.backup.connect();
    const second = harness({ storage: run.storage, accountId: B });
    expect(second.backup.status()).toEqual({ kind: "off", enabled: false });
  });

  it("preserves a readable committed snapshot after a cancelled changed pass", async () => {
    const run = harness(); await run.backup.connect();
    const entered = deferred(), release = deferred();
    run.deps.snapshot = async () => { entered.resolve(); await release.promise; return snapshotOf(4); };
    const pending = run.backup.uploadNow(); await entered.promise;
    run.backup.forget(); release.resolve(); await pending;
    const restored = await downloadBackup({ store: run.store,
      key: await importBackupKey(GEN, KEY_HEX), scope: { accountId: A, deviceId: DEVICE } });
    expect(restored.snapshot.messages).toHaveLength(3);
  });
});

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
    expect(backup.status()).toEqual({ kind: "off", enabled: false });
    backup.markDirty();
    await expect(backup.uploadNow()).resolves.toEqual({ kind: "skipped", reason: "off" });
    expect(store.names()).toEqual([]);
  });

  it("connects, uploads the first pass, and then reports up to date", async () => {
    const { backup, auth, store, storage, deps } = harness();
    await expect(backup.connect()).resolves.toMatchObject({ kind: "committed" });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(store.names().length).toBe(2);
    expect(parseBackupState(storage.raw()).enabled).toBe(true);
    expect(parseBackupState(storage.raw()).dirtyRevision).toBe(parseBackupState(storage.raw()).uploadedRevision);
    expect(parseBackupState(storage.raw()).generation).toBe(GEN);
    await expect(deps.snapshot(deps.captureLease()!)).resolves.toBeTruthy();
  });

  it("batches marked changes and waits for the batching delay", async () => {
    const run = harness();
    await run.backup.connect();
    const files = run.store.names();
    run.backup.markDirty();
    await expect(run.backup.tick()).resolves.toMatchObject({ kind: "skipped", reason: "not-ready" });
    expect(run.store.names()).toEqual(files);
    run.advance(BACKUP_MAX_DELAY_MS);
    await expect(run.backup.tick()).resolves.toMatchObject({ kind: "committed" });
    expect(parseBackupState(run.storage.raw()).dirtyRevision).toBe(parseBackupState(run.storage.raw()).uploadedRevision);
  });

  it("refreshes once a day even without changes", async () => {
    const run = harness();
    await run.backup.connect();
    const before = run.store.names();
    run.advance(BACKUP_COMPACT_MS - 1);
    run.advance(BACKUP_MAX_DELAY_MS);
    await run.backup.tick();
    expect(run.store.names()).toEqual(before);
    expect(parseBackupState(run.storage.raw()).dirtyRevision).toBe(parseBackupState(run.storage.raw()).uploadedRevision);
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
    expect(native.backup.status()).toEqual({ kind: "unavailable", reason: "native", enabled: false });
    const unconfigured = harness({ available: false, reason: "unconfigured" });
    expect(unconfigured.backup.status()).toEqual({ kind: "unavailable", reason: "unconfigured", enabled: false });
  });

  it("asks for a connection instead of uploading when the token is gone", async () => {
    const run = harness();
    await run.backup.connect();
    run.auth.drop();
    run.auth.renew.mockResolvedValueOnce(null);
    await expect(run.backup.uploadNow()).resolves.toMatchObject({ kind: "needs-connection" });
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

  it("keeps a repair-needed receipt instead of rebuilding after rotation", async () => {
    const run = harness();
    await run.backup.connect();
    const files = run.store.names();
    // A rotated key over the same Drive files cannot open the committed backup.
    const rotated = { accountId: A, generation: GEN2, keyHex: "cd".repeat(32), createdAt: NOW };
    const second = harness({
      storage: run.storage,
      store: run.store,
      key: () => rotated,
      snapshot: snapshotOf(2, "after rotation"),
    });
    await expect(second.backup.uploadNow()).resolves.toEqual({ kind: "failed", reason: "integrity" });
    // Nothing was deleted, replaced or re-published under the new generation.
    expect(run.store.names()).toEqual(files);
    expect(parseBackupState(second.storage.raw()).generation).toBe(GEN);
    expect(second.backup.status()).toMatchObject({ kind: "attention", lastError: "integrity" });
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
    expect(result.kind).toBe("restored");
    if (result.kind !== "restored") throw new Error("restore was not admitted");
    expect(result.messages).toBe(4);
    expect(target.imported?.messages).toHaveLength(4);
  });

  it("refuses to restore without a token or account", async () => {
    const run = harness();
    run.auth.drop();
    run.auth.renew.mockResolvedValueOnce(null);
    await expect(run.backup.restore()).resolves.toEqual({ kind: "needs-connection" });
    const anonymous = harness();
    anonymous.switchAccount(null);
    await expect(anonymous.backup.restore()).resolves.toEqual({ kind: "skipped", reason: "not-ready" });
  });
});
