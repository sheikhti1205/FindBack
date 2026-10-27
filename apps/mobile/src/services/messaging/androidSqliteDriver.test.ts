// @vitest-environment node
/**
 * Contract for the Capacitor SQLite bridge driver (`androidSqliteDriver.ts`).
 *
 * The native plugin is a seam fake here — this file pins the JavaScript
 * boundary only: platform guard, scope validation, parameter/row fidelity,
 * handle invalidation, error shape and the absence of any fallback or
 * message-body logging. Native SQLite behaviour is compiled and reviewed
 * separately and is NOT proven by this test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakePlugin, registerPluginMock, platform } = vi.hoisted(() => ({
  fakePlugin: {
    open: vi.fn<(options: { accountId: string }) => Promise<unknown>>(),
    exec: vi.fn<(options: { handle: string; sql: string }) => Promise<unknown>>(),
    all: vi.fn<(options: { handle: string; sql: string; params: unknown[] }) => Promise<unknown>>(),
    run: vi.fn<(options: { handle: string; sql: string; params: unknown[] }) => Promise<unknown>>(),
    close: vi.fn<(options: { handle: string }) => Promise<unknown>>(),
    installationId: vi.fn<() => Promise<unknown>>(),
  },
  registerPluginMock: vi.fn(),
  platform: { native: true, name: "android" },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: (name: string) => registerPluginMock(name),
}));

import {
  MessagingSqliteError,
  isAndroidMessagingStorageAvailable,
  openAndroidMessagingSqliteDriver,
  readAndroidInstallationId,
} from "./androidSqliteDriver";

const A = "00000000-0000-4000-8000-000000000001";
const INSTALLATION = "00000000-0000-4000-8000-0000000000aa";
/** Opaque native handle: nothing about the account or file path is derivable. */
const HANDLE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  for (const fn of Object.values(fakePlugin)) fn.mockReset();
  registerPluginMock.mockReset().mockImplementation(() => fakePlugin);
  platform.native = true;
  platform.name = "android";
  fakePlugin.open.mockResolvedValue({ handle: HANDLE });
  fakePlugin.installationId.mockResolvedValue({ id: INSTALLATION });
  fakePlugin.exec.mockResolvedValue(undefined);
  fakePlugin.all.mockResolvedValue({ rows: [] });
  fakePlugin.run.mockResolvedValue({ changes: 1 });
  fakePlugin.close.mockResolvedValue(undefined);
});

describe("platform guard", () => {
  it("is unavailable on web and never registers the bridge", () => {
    platform.native = false;
    platform.name = "web";
    expect(isAndroidMessagingStorageAvailable()).toBe(false);
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("treats iOS as explicitly unsupported, never as available", () => {
    platform.name = "ios";
    expect(isAndroidMessagingStorageAvailable()).toBe(false);
  });

  it("fails closed on web before any bridge call", async () => {
    platform.native = false;
    platform.name = "web";
    await expect(openAndroidMessagingSqliteDriver({ accountId: A })).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(registerPluginMock).not.toHaveBeenCalled();
    expect(fakePlugin.open).not.toHaveBeenCalled();
  });

  it("fails closed on iOS before any bridge call", async () => {
    platform.name = "ios";
    await expect(openAndroidMessagingSqliteDriver({ accountId: A })).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(fakePlugin.open).not.toHaveBeenCalled();
  });
});

describe("open", () => {
  it("rejects an account id that is not a UUID before touching the bridge", async () => {
    for (const accountId of ["", "not-a-uuid", "../../etc/passwd", `${A}/../x`]) {
      await expect(openAndroidMessagingSqliteDriver({ accountId })).rejects.toMatchObject({
        kind: "invalid-scope",
      });
    }
    expect(fakePlugin.open).not.toHaveBeenCalled();
  });

  it("opens the native handle for the account and reports no path", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    expect(fakePlugin.open).toHaveBeenCalledWith({ accountId: A });
    expect(Object.keys(driver).sort()).toEqual(["all", "close", "exec", "run"]);
  });

  it("rejects a handle that is not a non-empty opaque string", async () => {
    for (const handle of [undefined, null, "", 7, { handle: "x" }, ["h"]]) {
      fakePlugin.open.mockResolvedValue({ handle });
      await expect(openAndroidMessagingSqliteDriver({ accountId: A })).rejects.toMatchObject({
        kind: "invalid-result",
      });
    }
  });

  it("surfaces a native open failure as our own stable error, never raw platform text", async () => {
    fakePlugin.open.mockRejectedValue(new Error("SQLITE_CANTOPEN /data/user/0/x/messaging"));
    const failure = await openAndroidMessagingSqliteDriver({ accountId: A })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MessagingSqliteError);
    if (!(failure instanceof MessagingSqliteError)) throw new Error("expected MessagingSqliteError");
    expect(failure.kind).toBe("open-failed");
    expect(String(failure.message)).not.toContain("/data/user/0");
    expect(String(failure.message)).not.toContain("SQLITE_CANTOPEN");
  });
});

describe("command forwarding", () => {
  it("forwards exec with the handle and no parameters", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    await driver.exec("pragma foreign_keys = on");
    expect(fakePlugin.exec).toHaveBeenCalledWith({ handle: HANDLE, sql: "pragma foreign_keys = on" });
  });

  it("forwards all/run with the handle and bound parameters", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    await driver.all("select 1 as n", ["x"]);
    await driver.run("update t set a = ?", [0]);
    expect(fakePlugin.all).toHaveBeenCalledWith({ handle: HANDLE, sql: "select 1 as n", params: ["x"] });
    expect(fakePlugin.run).toHaveBeenCalledWith({ handle: HANDLE, sql: "update t set a = ?", params: [0] });
  });

  it("preserves numeric and null parameters exactly", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    const params = [0, -1, 2.5, 1_700_000_000_000, "", null] as const;
    await driver.run("update t set a = ?", params);
    const sent = fakePlugin.run.mock.calls[0]?.[0]?.params;
    expect(sent).toEqual([0, -1, 2.5, 1_700_000_000_000, "", null]);
    expect(sent?.map((value) => typeof value)).toEqual([
      "number", "number", "number", "number", "string", "object",
    ]);

    await driver.all("select ? as zero, ? as absent", [0, null]);
    expect(fakePlugin.all).toHaveBeenCalledWith({
      handle: HANDLE,
      sql: "select ? as zero, ? as absent",
      params: [0, null],
    });
  });

  it("rejects unsupported parameter values before dispatch", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    const bad: unknown[] = [
      true, false, {}, [], undefined, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1, () => 1, 1n,
    ];
    for (const value of bad) {
      await expect(driver.run("update t set a = ?", [value as never])).rejects.toMatchObject({
        kind: "invalid-command",
      });
    }
    expect(fakePlugin.run).not.toHaveBeenCalled();
  });

  it("returns rows unchanged when every value is a string, number or null", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    const rows = [{ journal_mode: "wal", synchronous: 2, foreign_keys: 1, server_sequence: null }];
    fakePlugin.all.mockResolvedValue({ rows });
    await expect(driver.all("pragma journal_mode")).resolves.toEqual(rows);
  });

  it("rejects a malformed native row payload instead of trusting it", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    const bad: unknown[] = [
      null,
      { rows: "wal" },
      { rows: [null] },
      { rows: [[1]] },
      { rows: [{ ok: true }] },
      { rows: [{ ok: { nested: 1 } }] },
      { rows: [{ ok: Number.NaN }] },
      { rows: [{ ok: Number.MAX_SAFE_INTEGER + 1 }] },
    ];
    for (const payload of bad) {
      fakePlugin.all.mockResolvedValue(payload);
      await expect(driver.all("select 1 as ok")).rejects.toMatchObject({ kind: "invalid-result" });
    }
  });

  it("returns the changed-row count and rejects a malformed one", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    fakePlugin.run.mockResolvedValue({ changes: 3 });
    await expect(driver.run("delete from t")).resolves.toBe(3);
    for (const changes of [undefined, null, -1, 1.5, "1", Number.NaN]) {
      fakePlugin.run.mockResolvedValue({ changes });
      await expect(driver.run("delete from t")).rejects.toMatchObject({ kind: "invalid-result" });
    }
  });

  it("wraps a native command failure without echoing SQL, parameters or platform text", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    fakePlugin.run.mockRejectedValue(new Error("near \"secret body\": syntax error"));
    const failure = await Promise.resolve(driver.run("insert into messages values (?)", ["secret body"]))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(MessagingSqliteError);
    expect(failure.kind).toBe("command-failed");
    expect(String(failure.message)).not.toContain("secret body");
    expect(String(failure.message)).not.toContain("syntax error");
  });

  it("never writes SQL, parameters or native text to the console", async () => {
    const calls: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      }),
    );
    try {
      const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
      fakePlugin.run.mockRejectedValue(new Error("secret body"));
      await Promise.resolve(driver.run("insert into messages values (?)", ["secret body"]))
        .catch(() => undefined);
      await driver.close();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(JSON.stringify(calls)).not.toContain("secret body");
    expect(calls).toHaveLength(0);
  });
});

describe("close", () => {
  it("rejects an in-flight result that arrives after close invalidates its account handle", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    let release!: (value: unknown) => void;
    fakePlugin.all.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = driver.all("select body from messages");
    const rejected = expect(pending).rejects.toMatchObject({ kind: "handle-closed" });
    await driver.close();
    release({ rows: [{ body: "old account history" }] });
    await rejected;
  });

  it("invalidates the handle immediately and calls native close exactly once", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    await driver.close();
    await driver.close();
    expect(fakePlugin.close).toHaveBeenCalledTimes(1);
    expect(fakePlugin.close).toHaveBeenCalledWith({ handle: HANDLE });

    for (const operation of [
      () => driver.exec("commit"),
      () => driver.all("select 1"),
      () => driver.run("delete from t"),
    ]) {
      await expect(operation()).rejects.toMatchObject({ kind: "handle-closed" });
    }
    expect(fakePlugin.exec).not.toHaveBeenCalled();
    expect(fakePlugin.all).not.toHaveBeenCalled();
    expect(fakePlugin.run).not.toHaveBeenCalled();
  });

  it("rejects a command issued while the native close is still pending", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    let releaseClose!: () => void;
    fakePlugin.close.mockImplementation(
      () => new Promise<void>((resolve) => { releaseClose = resolve; }),
    );
    const closing = driver.close();
    await expect(driver.run("delete from outbox")).rejects.toMatchObject({ kind: "handle-closed" });
    expect(fakePlugin.run).not.toHaveBeenCalled();
    releaseClose();
    await closing;
  });

  it("stays invalidated even when native close fails", async () => {
    const driver = await openAndroidMessagingSqliteDriver({ accountId: A });
    fakePlugin.close.mockRejectedValue(new Error("native close exploded"));
    await expect(driver.close()).rejects.toMatchObject({ kind: "command-failed" });
    await expect(driver.all("select 1")).rejects.toMatchObject({ kind: "handle-closed" });
    expect(fakePlugin.all).not.toHaveBeenCalled();
  });
});

describe("installation identity", () => {
  it("returns the persisted installation UUID", async () => {
    await expect(readAndroidInstallationId()).resolves.toBe(INSTALLATION);
    expect(fakePlugin.installationId).toHaveBeenCalledTimes(1);
  });

  it("rejects a native id that is not a UUID", async () => {
    for (const id of [undefined, null, "", "install-1", `${INSTALLATION}x`]) {
      fakePlugin.installationId.mockResolvedValue({ id });
      await expect(readAndroidInstallationId()).rejects.toMatchObject({ kind: "invalid-result" });
    }
  });

  it("fails closed off Android without calling the bridge", async () => {
    platform.native = false;
    platform.name = "web";
    await expect(readAndroidInstallationId()).rejects.toMatchObject({ kind: "unavailable" });
    expect(fakePlugin.installationId).not.toHaveBeenCalled();
  });
});
