/**
 * Platform storage selection for human messaging.
 *
 * Exactly one durable adapter is chosen from the platform, never from a failure:
 * Android gets the app-private native SQLite database, web gets the existing
 * IndexedDB adapter, and iOS is explicitly unsupported. There is no try/catch
 * fallback chain and no in-memory persistence — a failed Android open is a
 * failed chat-history open, not a silent downgrade.
 *
 * Installation identity: Android reads the plugin's persisted random UUID, so
 * the same database is reopened with the same scope after a restart. Web keeps
 * the existing contract (the session owner supplies the installation UUID).
 */
import { Capacitor } from "@capacitor/core";
import type { MessagingHistory, MessagingScope } from "./history";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import {
  openAndroidMessagingSqliteDriver,
  readAndroidInstallationId,
} from "./androidSqliteDriver";
import { isUuid } from "./validation";
import {
  assertMediaBytesOwner, openScopedMediaBytes, type ScopedMediaBytes, type MessagingStorageScope,
  assertMessagingAccountActive, registerMessagingStorageScope, beginMessagingAccountDeletion,
  inspectMessagingStorageScopes, finishMessagingAccountDeletion, openMessagingCleanupBytes,
  registerMessagingCleanupScope,
} from "./scopedMediaBytes";

export type MessagingPlatformFailure = "unsupported" | "invalid-scope" | "already-open";

const PLATFORM_MESSAGE: Record<MessagingPlatformFailure, string> = {
  unsupported: "Chat history is not available on this platform.",
  "invalid-scope": "Chat history requires a signed-in account.",
  "already-open": "Chat history is already open for this account.",
};

const PLATFORM_CODE: Record<MessagingPlatformFailure, string> = {
  unsupported: "MESSAGING_STORAGE_UNSUPPORTED",
  "invalid-scope": "MESSAGING_STORAGE_INVALID_SCOPE",
  "already-open": "MESSAGING_STORAGE_ALREADY_OPEN",
};

export class MessagingPlatformError extends Error {
  readonly kind: MessagingPlatformFailure;
  readonly code: string;

  constructor(kind: MessagingPlatformFailure) {
    super(PLATFORM_MESSAGE[kind]);
    this.name = "MessagingPlatformError";
    this.kind = kind;
    this.code = PLATFORM_CODE[kind];
  }
}

// Reserve before the first await. Independent adapters have independent
// transaction queues, so they must never share one native account file.
const androidOwners = new Set<string>();

export interface PlatformMessagingHandle {
  platform: "android" | "web";
  /** The scope the durable database was opened with. Pass it to the session. */
  scope: MessagingScope;
  history: MessagingHistory;
  /**
   * Invalidates the handle immediately and resolves after the platform close.
   * Callers MUST call this on sign-out/account switch; local history is retained
   * for the same identity, it is not an account-deletion/purge.
   */
  close(): Promise<void>;
}

export interface PlatformMessagingOptions {
  accountId: string;
  /**
   * Web only. Android always uses the plugin's persisted installation UUID and
   * rejects a different value rather than silently opening a divergent scope.
   */
  deviceId?: string;
  /** Metadata on web; media bytes/ownership registry on both platforms. */
  indexedDB?: IDBFactory;
  /** Opt into the owned media store; callers cannot inject an arbitrary port. */
  media?: { backendUrl: string };
}

/** Both adapters invalidate synchronously, then drain admitted storage work. */
async function closeHistory(history: MessagingHistory): Promise<void> {
  await history.close();
}

function createHandle(
  platform: "android" | "web",
  scope: MessagingScope,
  history: MessagingHistory,
  release: () => void = () => undefined,
  bytes?: ScopedMediaBytes,
): PlatformMessagingHandle {
  let closing: Promise<void> | undefined;
  return {
    platform,
    scope,
    history,
    close: () => {
      // Never close bytes before history's admitted cleanup has drained, even
      // on failed native teardown. Preserve that original close failure and do
      // not release native ownership when either resource's close is uncertain.
      closing ??= closeHistory(history).then(async () => {
        await bytes?.close();
        release();
      }, async (error: unknown) => {
        await bytes?.close().catch(() => undefined);
        throw error;
      });
      return closing;
    },
  };
}

async function openBytes(platform: "android" | "web", scope: MessagingScope, options: PlatformMessagingOptions) {
  if (!options.media) return undefined;
  const owner = { platform, ...scope, backendUrl: options.media.backendUrl };
  const bytes = await openScopedMediaBytes(owner, { indexedDB: options.indexedDB });
  try { assertMediaBytesOwner(bytes, owner); }
  catch (error) { await bytes.close().catch(() => undefined); throw error; }
  return bytes;
}

async function openAndroid(options: PlatformMessagingOptions): Promise<PlatformMessagingHandle> {
  const { accountId, deviceId: requestedDeviceId } = options;
  if (androidOwners.has(accountId)) throw new MessagingPlatformError("already-open");
  androidOwners.add(accountId);
  const release = () => { androidOwners.delete(accountId); };
  let driver: Awaited<ReturnType<typeof openAndroidMessagingSqliteDriver>> | undefined;
  let bytes: ScopedMediaBytes | undefined;
  try {
    // Identity comes from the plugin's persisted UUID before any file is opened,
    // so a restart reopens the same database under the same scope.
    const deviceId = await readAndroidInstallationId();
    if (requestedDeviceId !== undefined && requestedDeviceId !== deviceId) {
      throw new MessagingPlatformError("invalid-scope");
    }
    const scope = { accountId, deviceId };
    await registerMessagingStorageScope({ platform: "android", ...scope, backendUrl: options.media?.backendUrl }, options.indexedDB);
    bytes = await openBytes("android", scope, options);
    driver = await openAndroidMessagingSqliteDriver({ accountId });
    const history = await openSqliteMessagingHistory(driver, scope, { mediaBytes: bytes,
      accountAdmission: () => assertMessagingAccountActive(accountId, options.indexedDB) });
    await assertMessagingAccountActive(accountId, options.indexedDB);
    return createHandle("android", scope, history, release, bytes);
  } catch (error) {
    // The adapter closes its own driver on every failure path; this is a
    // belt-and-braces invalidation so no handle survives a failed open.
    // A failed close deliberately retains ownership. Do not expose another
    // writer until native teardown is known to have succeeded.
    let released = true;
    try { await driver?.close(); } catch { released = false; }
    try { await bytes?.close(); } catch { released = false; }
    if (released) release();
    throw error;
  }
}

async function openWeb(options: PlatformMessagingOptions): Promise<PlatformMessagingHandle> {
  const { accountId, deviceId } = options;
  if (!isUuid(deviceId)) throw new MessagingPlatformError("invalid-scope");
  const scope = { accountId, deviceId };
  await registerMessagingStorageScope({ platform: "web", ...scope, backendUrl: options.media?.backendUrl }, options.indexedDB);
  const bytes = await openBytes("web", scope, options);
  let history: MessagingHistory | undefined;
  try {
    history = await openWebMessagingHistory(scope, { indexedDB: options.indexedDB, mediaBytes: bytes,
      accountAdmission: () => assertMessagingAccountActive(accountId, options.indexedDB) });
    await assertMessagingAccountActive(accountId, options.indexedDB);
    return createHandle("web", scope, history, undefined, bytes);
  } catch (error) {
    try { await history?.close(); } catch { /* preserve setup failure */ }
    await bytes?.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens the one durable history adapter for this platform.
 *
 * Android: native SQLite, fails closed. Web: IndexedDB. iOS: unsupported.
 */
export async function openPlatformMessagingHistory(
  options: PlatformMessagingOptions,
): Promise<PlatformMessagingHandle> {
  const accountId = options?.accountId;
  if (!isUuid(accountId)) throw new MessagingPlatformError("invalid-scope");
  // No owner fields may be retargeted by caller mutation across installation,
  // registry, or database awaits.
  const captured = { accountId, deviceId: options.deviceId, indexedDB: options.indexedDB,
    media: options.media ? { backendUrl: options.media.backendUrl } : undefined };

  const platform = Capacitor.getPlatform();
  if (platform === "ios") throw new MessagingPlatformError("unsupported");
  if (Capacitor.isNativePlatform()) {
    if (platform !== "android") throw new MessagingPlatformError("unsupported");
    return openAndroid(captured);
  }
  return openWeb(captured);
}

/** Opens only the recorded scope, not today's installation or configured backend.
 * No session/registration/sync is constructed. A lost native close holds its lease. */
async function purgeRecordedScope(owner: Readonly<MessagingStorageScope>, factory?: IDBFactory): Promise<void> {
  const native = owner.platform === "android";
  if (native && (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")) {
    throw new MessagingPlatformError("unsupported");
  }
  if (native && androidOwners.has(owner.accountId)) throw new MessagingPlatformError("already-open");
  if (native) androidOwners.add(owner.accountId);
  let bytes: ScopedMediaBytes | undefined;
  let driver: Awaited<ReturnType<typeof openAndroidMessagingSqliteDriver>> | undefined;
  let history: MessagingHistory | undefined;
  let failure: unknown;
  let closeFailed = false;
  try {
    bytes = await openMessagingCleanupBytes(owner, factory);
    if (native) {
      driver = await openAndroidMessagingSqliteDriver({ accountId: owner.accountId });
      history = await openSqliteMessagingHistory(driver, owner, { mediaBytes: bytes, cleanupOnly: true });
    } else {
      history = await openWebMessagingHistory(owner, { indexedDB: factory, mediaBytes: bytes, cleanupOnly: true });
    }
    await history.purgeHistory();
  } catch (error) { failure = error; }
  try { if (history) await history.close(); else await driver?.close(); }
  catch (error) { closeFailed = true; failure ??= error; }
  try { await bytes?.close(); }
  catch (error) { closeFailed = true; failure ??= error; }
  if (native && !closeFailed) androidOwners.delete(owner.accountId);
  if (failure) throw failure;
}

/** Legacy web text databases predate the ownership registry. Database names can
 * recover account/installation, never a media backend. Registered owners remain
 * authoritative; enumeration only discovers the legacy gap, never replaces it. */
async function discoverLegacyWebScopes(accountId: string, factory: IDBFactory): Promise<void> {
  if (typeof factory.databases !== "function") throw new Error("Messaging legacy inventory unavailable");
  const names = await factory.databases();
  const prefix = `findback-human-history-v1:${accountId}:`;
  const failures: unknown[] = [];
  for (const row of names) {
    if (!row.name?.startsWith(prefix)) continue;
    try {
      const deviceId = row.name.slice(prefix.length);
      if (!isUuid(deviceId)) throw new Error("Messaging legacy scope invalid");
      await registerMessagingCleanupScope({ platform: "web", accountId, deviceId }, factory);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Messaging legacy inventory incomplete");
}

/** Native filename is account-bound. A pre-registry file carries its original
 * device in messaging_meta; today's installation must not retarget that file. */
async function discoverLegacyAndroidScope(accountId: string, factory: IDBFactory): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  if ((await inspectMessagingStorageScopes(accountId, factory)).scopes.some((scope) => scope.platform === "android")) return;
  if (androidOwners.has(accountId)) throw new MessagingPlatformError("already-open");
  androidOwners.add(accountId);
  let driver: Awaited<ReturnType<typeof openAndroidMessagingSqliteDriver>> | undefined;
  let failure: unknown, closeFailed = false;
  try {
    driver = await openAndroidMessagingSqliteDriver({ accountId });
    const table = await driver.all<{ name: string }>("select name from sqlite_master where type = 'table' and name = 'messaging_meta'");
    let deviceId: string;
    if (table.length) {
      const rows = await driver.all<{ key: string; value: string }>("select key, value from messaging_meta");
      const prior = new Map(rows.map((row) => [row.key, row.value]));
      if (prior.get("account_id") !== accountId || !isUuid(prior.get("device_id"))) {
        throw new Error("Messaging legacy ownership invalid");
      }
      deviceId = prior.get("device_id")!;
    } else deviceId = await readAndroidInstallationId();
    await registerMessagingCleanupScope({ platform: "android", accountId, deviceId }, factory);
  } catch (error) { failure = error; }
  try { await driver?.close(); } catch (error) { closeFailed = true; failure ??= error; }
  if (!closeFailed) androidOwners.delete(accountId);
  if (failure) throw failure;
}

/** Local logical deletion for ALL known scopes. Failures remain durably pending;
 * other scopes are still attempted. Ordinary close/logout never calls this. */
export async function purgePlatformMessagingAccount(accountId: string, options: { indexedDB?: IDBFactory } = {}): Promise<void> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const revision = await beginMessagingAccountDeletion(accountId, factory);
  const failures: unknown[] = [];
  // Inventory failure must not prevent known scopes being erased, nor may it
  // clear pending and claim that unknown legacy history was removed.
  try { await discoverLegacyWebScopes(accountId, factory); } catch (error) { failures.push(error); }
  try { await discoverLegacyAndroidScope(accountId, factory); } catch (error) { failures.push(error); }
  const { scopes, failures: inventoryFailures } = await inspectMessagingStorageScopes(accountId, factory);
  failures.push(...inventoryFailures);
  for (const scope of scopes) {
    try { await purgeRecordedScope(scope, factory); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Messaging account deletion incomplete");
  await finishMessagingAccountDeletion(accountId, revision, factory);
}
