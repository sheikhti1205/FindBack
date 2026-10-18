import { describe, expect, it, vi } from "vitest";

/**
 * Regression net for the real Capacitor seam.
 *
 * `pushNotifications.test.ts` drives `createPushController` with a hand-written
 * fake adapter, so it never executes `createCapacitorPushAdapter` — the adapter
 * that actually talks to the native plugin. That gap hid a total push outage:
 * nobody crossed the seam, so nothing observed the failure.
 *
 * The hazard being pinned: `registerPlugin` returns a Proxy that answers EVERY
 * property access with a callable forwarded to the native bridge, `then`
 * included. Promise resolution invokes `.then` on any thenable, so a promise
 * that resolves *with the proxy itself* calls `PushNotifications.then()` on
 * native, which throws `"PushNotifications.then()" is not implemented on
 * android` and rejects the whole flow before it reaches the bridge.
 */

type ProxyTarget = Record<string, unknown>;

function capacitorPluginProxy(calls: string[]) {
  return new Proxy({} as ProxyTarget, {
    get: (_target, prop) => {
      if (prop === "then") {
        // Exactly what the bridge answers for an unimplemented method.
        return () => {
          throw new Error(`"PushNotifications.${String(prop)}()" is not implemented on android`);
        };
      }
      return (..._args: unknown[]) => {
        calls.push(String(prop));
        if (prop === "requestPermissions") return Promise.resolve({ receive: "granted" });
        if (prop === "checkPermissions") return Promise.resolve({ receive: "prompt" });
        if (prop === "addListener") return Promise.resolve({ remove: () => {} });
        return Promise.resolve(undefined);
      };
    },
  });
}

async function adapterWith(proxy: unknown) {
  vi.resetModules();
  vi.doMock("@capacitor/push-notifications", () => ({ PushNotifications: proxy }));
  const { createCapacitorPushAdapter } = await import("./pushNotifications");
  return createCapacitorPushAdapter();
}

describe("createCapacitorPushAdapter against a real Capacitor plugin proxy", () => {
  it("resolves a permission request without invoking `then` on the proxy", async () => {
    const calls: string[] = [];
    const adapter = await adapterWith(capacitorPluginProxy(calls));

    await expect(adapter.requestPermission()).resolves.toBe("granted");
    expect(calls).toContain("requestPermissions");
    expect(calls).not.toContain("then");
  });

  it("reaches the bridge for registration rather than dying at the proxy", async () => {
    const calls: string[] = [];
    const adapter = await adapterWith(capacitorPluginProxy(calls));

    await expect(adapter.register()).resolves.toBeUndefined();
    expect(calls).toContain("register");
    expect(calls).not.toContain("then");
  });

  it("subscribes to registration events through the bridge", async () => {
    const calls: string[] = [];
    const adapter = await adapterWith(capacitorPluginProxy(calls));

    const off = await adapter.onRegistration(() => {});
    expect(calls).toContain("addListener");
    expect(calls).not.toContain("then");
    expect(typeof off).toBe("function");
  });
});
