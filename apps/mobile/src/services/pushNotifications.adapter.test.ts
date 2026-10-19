// @vitest-environment jsdom
// jsdom is required (not for DOM behaviour): `createCapacitorPushAdapter`'s
// `isNative()`/`platform()` read `window.Capacitor`, which does not exist in
// the default node environment.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapacitorPushAdapter } from "./pushNotifications";

/**
 * Exercise the production adapter against the INSTALLED Capacitor runtime
 * (`@capacitor/core` + `@capacitor/push-notifications`), replacing only the OS
 * bridge. There is no fake proxy here: the real `registerPlugin` proxy and the
 * real listener wrappers run. A synchronous-throw fake cannot characterize the
 * original outage — returning the proxy from an async loader leaves the caller
 * pending and reports only as an unhandled inner rejection.
 *
 * Both globals must exist BEFORE `@capacitor/core` is evaluated: core reads
 * `win.Capacitor` once at module init (`const cap = win.Capacitor || {}`,
 * `dist/index.js:43`) and `registerPlugin` reads `cap.PluginHeaders`
 * (`:61`). `vi.hoisted` is what guarantees that ordering. Stub later — or
 * statically import core before stubbing — and `PluginHeaders` is `undefined`,
 * so every call throws `"PushNotifications" plugin is not implemented on
 * android` and the bridge spies are never reached.
 */
const { bridge, listeners, nativePromise, nativeCallback } = vi.hoisted(() => {
  const listeners = new Map<string, (value: unknown) => void>();
  const nativePromise = vi.fn();
  const nativeCallback = vi.fn();
  const bridge = {
    PluginHeaders: [
      {
        name: "PushNotifications",
        methods: [
          ...["requestPermissions", "checkPermissions", "register", "unregister"].map((name) => ({
            name,
            rtype: "promise",
          })),
          { name: "addListener" },
          { name: "removeListener" },
        ],
      },
      // Open-settings goes through the separate synchronous accessor at
      // `pushNotifications.ts:190`, not through the PushNotifications plugin.
      { name: "FindbackNotifications", methods: [{ name: "openSettings", rtype: "promise" }] },
    ],
    nativePromise,
    nativeCallback,
  };
  const globals = globalThis as Record<string, unknown>;
  globals.Capacitor = bridge;
  // `androidBridge` is what decides `platform()`: core's `getPlatformId` reads
  // it dynamically, so removing it flips the runtime to "web".
  globals.androidBridge = { postMessage: () => {} };
  return { bridge, listeners, nativePromise, nativeCallback };
});

function nativeAdapter(permission = "granted") {
  listeners.clear();
  nativePromise.mockReset();
  nativeCallback.mockReset();
  nativePromise.mockImplementation(async (_plugin: string, method: string) => {
    if (method === "requestPermissions" || method === "checkPermissions") {
      return { receive: permission };
    }
    return undefined;
  });
  nativeCallback.mockImplementation((
    _plugin: string,
    method: string,
    options: { eventName?: string; callbackId?: string },
    callback?: (value: unknown) => void,
  ) => {
    if (method === "addListener" && options.eventName && callback) {
      listeners.set(options.eventName, callback);
      return `callback:${options.eventName}`;
    }
    if (method === "removeListener" && options.eventName) listeners.delete(options.eventName);
    return "";
  });
  return { adapter: createCapacitorPushAdapter(), nativePromise, nativeCallback, listeners };
}

afterEach(() => {
  // The bridge itself stays installed: it must precede core's module
  // evaluation, so it is pinned in `vi.hoisted` rather than per test.
  listeners.clear();
});

describe("createCapacitorPushAdapter with the installed Capacitor runtime", () => {
  it("reports the host platform, and reports web once the native bridge is absent", () => {
    const { adapter } = nativeAdapter();
    expect(adapter.isNative()).toBe(true);
    expect(adapter.platform()).toBe("android");
    delete (globalThis as Record<string, unknown>).androidBridge;
    try {
      expect(adapter.isNative()).toBe(false);
      expect(adapter.platform()).toBe("web");
    } finally {
      (globalThis as Record<string, unknown>).androidBridge = { postMessage: () => {} };
    }
  });

  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["prompt-with-rationale", "prompt"],
  ])("maps request permission %s to %s after reaching native", async (receive, expected) => {
    const { adapter, nativePromise } = nativeAdapter(receive);
    await expect(adapter.requestPermission()).resolves.toBe(expected);
    expect(nativePromise).toHaveBeenCalledExactlyOnceWith("PushNotifications", "requestPermissions", undefined);
  });

  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["prompt", "prompt"],
  ])("checks permission %s without requesting it", async (receive, expected) => {
    const { adapter, nativePromise } = nativeAdapter(receive);
    await expect(adapter.checkPermission!()).resolves.toBe(expected);
    expect(nativePromise).toHaveBeenCalledExactlyOnceWith("PushNotifications", "checkPermissions", undefined);
  });

  it("registers through the real proxy rather than hanging on then", async () => {
    const { adapter, nativePromise } = nativeAdapter();
    await expect(adapter.register()).resolves.toBeUndefined();
    expect(nativePromise).toHaveBeenCalledExactlyOnceWith("PushNotifications", "register", undefined);
  });

  it("unregisters the native token", async () => {
    const { adapter, nativePromise } = nativeAdapter();
    await expect(adapter.deleteToken!()).resolves.toBeUndefined();
    expect(nativePromise).toHaveBeenCalledExactlyOnceWith("PushNotifications", "unregister", undefined);
  });

  it("opens notification settings through the settings plugin", async () => {
    const { adapter, nativePromise } = nativeAdapter();
    await expect(adapter.openSettings!()).resolves.toBeUndefined();
    expect(nativePromise).toHaveBeenCalledExactlyOnceWith("FindbackNotifications", "openSettings", undefined);
  });

  it("delivers registration tokens and removes the same native listener", async () => {
    const { adapter, nativeCallback, listeners } = nativeAdapter();
    const receive = vi.fn();
    const off = await adapter.onRegistration(receive);
    expect(nativeCallback).toHaveBeenCalledWith("PushNotifications", "addListener", { eventName: "registration" }, expect.any(Function));
    listeners.get("registration")!({ value: "device-token" });
    expect(receive).toHaveBeenCalledExactlyOnceWith("device-token");
    off();
    await vi.waitFor(() => expect(listeners.has("registration")).toBe(false));
    expect(nativeCallback).toHaveBeenLastCalledWith("PushNotifications", "removeListener", {
      eventName: "registration", callbackId: "callback:registration",
    }, expect.any(Function));
  });

  it("delivers registration errors with a safe fallback", async () => {
    const { adapter, listeners } = nativeAdapter();
    const receive = vi.fn();
    await adapter.onRegistrationError(receive);
    listeners.get("registrationError")!({ error: "permission unavailable" });
    listeners.get("registrationError")!({ error: 42 });
    expect(receive.mock.calls).toEqual([["permission unavailable"], ["registration error"]]);
  });

  it("delivers received notification data, defaulting absent data to an object", async () => {
    const { adapter, listeners } = nativeAdapter();
    const receive = vi.fn();
    await adapter.onReceived(receive);
    listeners.get("pushNotificationReceived")!({ data: { postId: "report-1" } });
    listeners.get("pushNotificationReceived")!({});
    expect(receive.mock.calls).toEqual([[{ postId: "report-1" }], [{}]]);
  });

  it("delivers tapped notification data, defaulting absent data to an object", async () => {
    const { adapter, listeners } = nativeAdapter();
    const receive = vi.fn();
    await adapter.onAction(receive);
    listeners.get("pushNotificationActionPerformed")!({ notification: { data: { postId: "report-2" } } });
    listeners.get("pushNotificationActionPerformed")!({ notification: {} });
    expect(receive.mock.calls).toEqual([[{ postId: "report-2" }], [{}]]);
  });
});

describe("the fixture is only valid because the bridge precedes core", () => {
  it("has the bridge core captured at evaluation time", () => {
    expect((globalThis as { Capacitor?: { PluginHeaders?: unknown } }).Capacitor?.PluginHeaders).toBeDefined();
    expect(bridge.PluginHeaders.length).toBe(2);
  });
});
