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
  /** Web/test injection for the IndexedDB factory. */
  indexedDB?: IDBFactory;
}

/** The web adapter closes synchronously; the SQLite adapter returns a promise. */
async function closeHistory(history: MessagingHistory): Promise<void> {
  await Promise.resolve((history as unknown as { close(): unknown }).close());
}

function createHandle(
  platform: "android" | "web",
  scope: MessagingScope,
  history: MessagingHistory,
  release: () => void = () => undefined,
): PlatformMessagingHandle {
  let closing: Promise<void> | undefined;
  return {
    platform,
    scope,
    history,
    close: () => {
      closing ??= closeHistory(history).then(release);
      return closing;
    },
  };
}

async function openAndroid(accountId: string, requestedDeviceId?: string): Promise<PlatformMessagingHandle> {
  if (androidOwners.has(accountId)) throw new MessagingPlatformError("already-open");
  androidOwners.add(accountId);
  const release = () => { androidOwners.delete(accountId); };
  let driver: Awaited<ReturnType<typeof openAndroidMessagingSqliteDriver>> | undefined;
  try {
    // Identity comes from the plugin's persisted UUID before any file is opened,
    // so a restart reopens the same database under the same scope.
    const deviceId = await readAndroidInstallationId();
    if (requestedDeviceId !== undefined && requestedDeviceId !== deviceId) {
      throw new MessagingPlatformError("invalid-scope");
    }
    driver = await openAndroidMessagingSqliteDriver({ accountId });
    const history = await openSqliteMessagingHistory(driver, { accountId, deviceId });
    return createHandle("android", { accountId, deviceId }, history, release);
  } catch (error) {
    // The adapter closes its own driver on every failure path; this is a
    // belt-and-braces invalidation so no handle survives a failed open.
    // A failed close deliberately retains ownership. Do not expose another
    // writer until native teardown is known to have succeeded.
    if (driver) await driver.close();
    release();
    throw error;
  }
}

async function openWeb(options: PlatformMessagingOptions): Promise<PlatformMessagingHandle> {
  const { accountId, deviceId } = options;
  if (!isUuid(deviceId)) throw new MessagingPlatformError("invalid-scope");
  const history = await openWebMessagingHistory({ accountId, deviceId }, { indexedDB: options.indexedDB });
  return createHandle("web", { accountId, deviceId }, history);
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

  const platform = Capacitor.getPlatform();
  if (platform === "ios") throw new MessagingPlatformError("unsupported");
  if (Capacitor.isNativePlatform()) {
    if (platform !== "android") throw new MessagingPlatformError("unsupported");
    return openAndroid(accountId, options.deviceId);
  }
  return openWeb(options);
}
