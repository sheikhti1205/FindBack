/**
 * Capacitor bridge driver for the Android messaging SQLite database.
 *
 * This module is the ONLY JavaScript surface over the native
 * `FindbackMessagingSqlite` plugin. It is a thin transport: it owns no schema,
 * no messaging policy and no file naming — the plugin opens one app-private,
 * fixed-name database per validated account and hands back an opaque handle.
 *
 * Fail-closed rules pinned by `androidSqliteDriver.test.ts`:
 *   - off Android every call rejects before the bridge is registered (iOS is
 *     reported as explicitly unsupported, never as "maybe later"),
 *   - the account id must be a UUID before any native call, so no caller can
 *     influence the database path,
 *   - parameters are restricted to `string | number | null` and must be finite,
 *     because a non-finite number would silently serialize as `null` and change
 *     what gets stored,
 *   - native results are validated, never trusted: a malformed row, count or
 *     handle rejects the call instead of entering durable state,
 *   - `close()` invalidates the handle synchronously, so a queued or
 *     old-account continuation cannot reach native storage or ACK after
 *     sign-out, and native close is dispatched once,
 *   - there is no IndexedDB, memory or other fallback on this path.
 *
 * Privacy: SQL text and bound parameters are never logged. Parameters carry
 * message bodies, and native error strings can echo them.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { SqliteDriver, SqliteValue } from "./sqliteHistory";
import { isUuid } from "./validation";

export const MESSAGING_SQLITE_PLUGIN = "FindbackMessagingSqlite";

/** 32 SecureRandom bytes encoded URL-safe Base64 without padding. */
const OPAQUE_HANDLE = /^[A-Za-z0-9_-]{43}$/;

export type MessagingSqliteFailure =
  | "unavailable"
  | "unsupported"
  | "invalid-scope"
  | "invalid-command"
  | "invalid-result"
  | "open-failed"
  | "command-failed"
  | "handle-closed";

/** Consumer-safe text only: never native/platform text, never SQL. */
const FAILURE_MESSAGE: Record<MessagingSqliteFailure, string> = {
  unavailable: "Messaging storage is unavailable on this device.",
  unsupported: "Messaging storage is not supported on this platform.",
  "invalid-scope": "Messaging storage requires a signed-in account.",
  "invalid-command": "Messaging storage rejected an invalid request.",
  "invalid-result": "Messaging storage returned an unusable response.",
  "open-failed": "Messaging storage could not be opened.",
  "command-failed": "Messaging storage could not complete the request.",
  "handle-closed": "Messaging storage closed.",
};

const FAILURE_CODE: Record<MessagingSqliteFailure, string> = {
  unavailable: "MESSAGING_SQLITE_UNAVAILABLE",
  unsupported: "MESSAGING_SQLITE_UNSUPPORTED",
  "invalid-scope": "MESSAGING_SQLITE_INVALID_SCOPE",
  "invalid-command": "MESSAGING_SQLITE_INVALID_COMMAND",
  "invalid-result": "MESSAGING_SQLITE_INVALID_RESULT",
  "open-failed": "MESSAGING_SQLITE_OPEN_FAILED",
  "command-failed": "MESSAGING_SQLITE_COMMAND_FAILED",
  "handle-closed": "MESSAGING_SQLITE_CLOSED",
};

export class MessagingSqliteError extends Error {
  readonly kind: MessagingSqliteFailure;
  readonly code: string;

  constructor(kind: MessagingSqliteFailure) {
    super(FAILURE_MESSAGE[kind]);
    this.name = "MessagingSqliteError";
    this.kind = kind;
    this.code = FAILURE_CODE[kind];
  }
}

interface NativeMessagingSqlite {
  open(options: { accountId: string }): Promise<unknown>;
  exec(options: { handle: string; sql: string }): Promise<unknown>;
  all(options: { handle: string; sql: string; params: SqliteValue[] }): Promise<unknown>;
  run(options: { handle: string; sql: string; params: SqliteValue[] }): Promise<unknown>;
  close(options: { handle: string }): Promise<unknown>;
  installationId(): Promise<unknown>;
}

let bridge: NativeMessagingSqlite | null = null;

/** Registered lazily so no non-Android platform ever touches the bridge. */
function nativeBridge(): NativeMessagingSqlite {
  if (!bridge) bridge = registerPlugin<NativeMessagingSqlite>(MESSAGING_SQLITE_PLUGIN);
  return bridge;
}

export function isAndroidMessagingStorageAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function assertAndroid(): void {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") throw new MessagingSqliteError("unsupported");
  if (platform !== "android" || !Capacitor.isNativePlatform()) {
    throw new MessagingSqliteError("unavailable");
  }
}

function assertParams(params: unknown): readonly SqliteValue[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new MessagingSqliteError("invalid-command");
  for (const value of params) {
    if (value === null || typeof value === "string") continue;
    // A non-finite number serializes to `null` over the bridge, which would
    // store a different value than the caller asked for.
    if (typeof value === "number" && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) continue;
    throw new MessagingSqliteError("invalid-command");
  }
  return params as readonly SqliteValue[];
}

function assertSql(sql: unknown): string {
  if (typeof sql !== "string" || !sql.trim()) throw new MessagingSqliteError("invalid-command");
  return sql;
}

function assertHandle(value: unknown): string {
  const handle = (value as { handle?: unknown } | null | undefined)?.handle;
  if (typeof handle !== "string" || !OPAQUE_HANDLE.test(handle)) {
    throw new MessagingSqliteError("invalid-result");
  }
  return handle;
}

function assertRows(value: unknown): Record<string, SqliteValue>[] {
  const rows = (value as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows)) throw new MessagingSqliteError("invalid-result");
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new MessagingSqliteError("invalid-result");
    }
    for (const field of Object.values(row)) {
      if (field === null || typeof field === "string") continue;
      if (typeof field === "number" && Number.isFinite(field)
        && (!Number.isInteger(field) || Number.isSafeInteger(field))) continue;
      throw new MessagingSqliteError("invalid-result");
    }
  }
  return rows as Record<string, SqliteValue>[];
}

function assertChanges(value: unknown): number {
  const changes = (value as { changes?: unknown } | null | undefined)?.changes;
  if (typeof changes !== "number" || !Number.isSafeInteger(changes) || changes < 0) {
    throw new MessagingSqliteError("invalid-result");
  }
  return changes;
}

/** Reads the app's persisted random installation UUID (never derived, never logged). */
export async function readAndroidInstallationId(): Promise<string> {
  assertAndroid();
  let result: unknown;
  try {
    result = await nativeBridge().installationId();
  } catch (error) {
    throw error instanceof MessagingSqliteError ? error : new MessagingSqliteError("command-failed");
  }
  const id = (result as { id?: unknown } | null | undefined)?.id;
  if (!isUuid(id)) throw new MessagingSqliteError("invalid-result");
  return id;
}

/**
 * Opens the app-private messaging database for one validated account.
 *
 * The returned driver is a single serialized lane in the adapter's terms; the
 * plugin guarantees ordered execution and an opaque handle scoped to this
 * account and file.
 */
export async function openAndroidMessagingSqliteDriver(
  options: { accountId: string },
): Promise<SqliteDriver> {
  assertAndroid();
  const accountId = options?.accountId;
  if (!isUuid(accountId)) throw new MessagingSqliteError("invalid-scope");

  let opened: unknown;
  try {
    opened = await nativeBridge().open({ accountId });
  } catch (error) {
    throw error instanceof MessagingSqliteError ? error : new MessagingSqliteError("open-failed");
  }
  const handle = assertHandle(opened);

  let closed = false;
  let closing: Promise<void> | null = null;

  function assertOpen(): void {
    if (closed) throw new MessagingSqliteError("handle-closed");
  }

  /** Dispatches one native command; invalidation always wins the race. */
  async function command<T>(work: () => Promise<T>): Promise<T> {
    assertOpen();
    try {
      const result = await work();
      assertOpen();
      return result;
    } catch (error) {
      throw error instanceof MessagingSqliteError ? error : new MessagingSqliteError("command-failed");
    }
  }

  async function exec(sql: string): Promise<void> {
    assertOpen();
    const statement = assertSql(sql);
    await command(() => nativeBridge().exec({ handle, sql: statement }));
  }

  async function all<T = Record<string, SqliteValue>>(
    sql: string,
    params?: readonly SqliteValue[],
  ): Promise<T[]> {
    assertOpen();
    const statement = assertSql(sql);
    const bound = assertParams(params);
    const result = await command(() => nativeBridge().all({ handle, sql: statement, params: [...bound] }));
    return assertRows(result) as T[];
  }

  async function run(sql: string, params?: readonly SqliteValue[]): Promise<number> {
    assertOpen();
    const statement = assertSql(sql);
    const bound = assertParams(params);
    const result = await command(() => nativeBridge().run({ handle, sql: statement, params: [...bound] }));
    return assertChanges(result);
  }

  function close(): Promise<void> {
    if (closing) return closing;
    // Invalidate before the round trip: a queued continuation must not reach
    // native storage, and no ACK may follow sign-out.
    closed = true;
    closing = (async () => {
      try {
        await nativeBridge().close({ handle });
      } catch (error) {
        throw error instanceof MessagingSqliteError ? error : new MessagingSqliteError("command-failed");
      }
    })();
    return closing;
  }

  return { exec, all, run, close };
}
