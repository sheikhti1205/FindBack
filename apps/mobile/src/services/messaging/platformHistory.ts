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
import { assertMediaBytesOwner, openScopedMediaBytes, type ScopedMediaBytes } from "./scopedMediaBytes";

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
    bytes = await openBytes("android", scope, options);
    driver = await openAndroidMessagingSqliteDriver({ accountId });
    const history = await openSqliteMessagingHistory(driver, scope, { mediaBytes: bytes });
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
  const bytes = await openBytes("web", scope, options);
  try {
    const history = await openWebMessagingHistory(scope, { indexedDB: options.indexedDB, mediaBytes: bytes });
    return createHandle("web", scope, history, undefined, bytes);
  } catch (error) {
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
