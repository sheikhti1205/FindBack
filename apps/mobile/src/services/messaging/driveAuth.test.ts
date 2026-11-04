// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// A native build whose bridge cannot report plugin availability. `driveAuth`
// must fail closed there instead of resolving a plugin it cannot confirm.
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => { throw new Error("unconfirmable plugin must not be resolved"); },
}));
import {
  DRIVE_SCOPE,
  DRIVE_TOKEN_KEY,
  DriveAuthError,
  createDriveAuth,
  type NativeDriveAccess,
  type NativeDriveAuth,
} from "./driveAuth";

const CLIENT = "1234567890-abcdef.apps.googleusercontent.com";
const TOKEN = "ya29.a0AfH6SMBexampleTokenValue";

interface TokenConfig {
  client_id: string;
  scope: string;
  callback(response: Record<string, unknown>): void;
  error_callback?(error: { type?: string }): void;
}

/** A scripted GIS token client: the test decides how Google answers. */
function google(behaviour: (config: TokenConfig) => void) {
  const configs: TokenConfig[] = [];
  let loads = 0;
  const oauth2 = {
    initTokenClient(config: TokenConfig) {
      configs.push(config);
      return { requestAccessToken() { behaviour(config); } };
    },
  };
  return { oauth2, configs, loads: () => loads, load: async () => { loads++; return oauth2; } };
}

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    size: () => map.size,
  };
}

const success = (expires = 3600) => (config: TokenConfig) => {
  config.callback({ access_token: TOKEN, expires_in: expires, token_type: "Bearer" });
};

describe("connecting a Google account for backup", () => {
  it("requests only the app-private Drive scope, never a login scope", async () => {
    const api = google(success());
    const auth = createDriveAuth({ clientId: CLIENT, load: api.load, storage: storage(), native: false });
    await expect(auth.authorize()).resolves.toMatchObject({ token: TOKEN });
    expect(api.configs).toHaveLength(1);
    expect(api.configs[0]!.scope).toBe(DRIVE_SCOPE);
    expect(DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.appdata");
    expect(api.configs[0]!.client_id).toBe(CLIENT);
    expect(auth.current()?.token).toBe(TOKEN);
  });

  it("keeps the token across a reload but drops it once it is near expiry", async () => {
    const store = storage();
    let now = 1_000_000;
    const api = google(success(3600));
    const first = createDriveAuth({ clientId: CLIENT, load: api.load, storage: store, native: false, now: () => now });
    await first.authorize();
    const reloaded = createDriveAuth({ clientId: CLIENT, load: api.load, storage: store, native: false, now: () => now });
    expect(reloaded.current()?.token).toBe(TOKEN);

    now += 3600 * 1000;
    expect(reloaded.current()).toBeNull();
    expect(store.getItem(DRIVE_TOKEN_KEY)).toBeNull();
  });

  it("refuses malformed tokens and lifetimes instead of half-connecting", async () => {
    const cases: Array<(config: TokenConfig) => void> = [
      (config) => config.callback({ access_token: "short", expires_in: 3600 }),
      (config) => config.callback({ access_token: TOKEN, expires_in: 0 }),
      (config) => config.callback({ access_token: TOKEN, expires_in: 90_000 }),
      (config) => config.callback({ access_token: TOKEN, expires_in: "3600" }),
      (config) => config.callback({ access_token: "bad token with spaces", expires_in: 3600 }),
    ];
    for (const behaviour of cases) {
      const auth = createDriveAuth({ clientId: CLIENT, load: google(behaviour).load,
        storage: storage(), native: false });
      await expect(auth.authorize()).rejects.toBeInstanceOf(DriveAuthError);
      expect(auth.current()).toBeNull();
    }
  });

  it("reports a declined consent as declined, not as a network failure", async () => {
    const api = google((config) => config.error_callback?.({ type: "access_denied" }));
    const auth = createDriveAuth({ clientId: CLIENT, load: api.load, storage: storage(), native: false });
    const error = await auth.authorize().catch((err: unknown) => err as DriveAuthError);
    expect((error as DriveAuthError).kind).toBe("denied");
    expect((error as DriveAuthError).message).toBe("Google Drive access was not granted.");
  });

  it("fails closed where Google authorization is not usable", async () => {
    const native = createDriveAuth({ clientId: CLIENT, load: google(success()).load,
      storage: storage(), native: true });
    expect(native.available()).toBe(false);
    expect(native.unavailableReason()).toBe("native");
    await expect(native.authorize()).rejects.toMatchObject({ kind: "native" });

    const unconfigured = createDriveAuth({ clientId: "", load: google(success()).load,
      storage: storage(), native: false });
    expect(unconfigured.available()).toBe(false);
    expect(unconfigured.unavailableReason()).toBe("unconfigured");
    await expect(unconfigured.authorize()).rejects.toMatchObject({ kind: "unconfigured" });
  });

  it("renews silently only after a real connection, and never throws on renewal", async () => {
    const store = storage();
    const api = google(success());
    const auth = createDriveAuth({ clientId: CLIENT, load: api.load, storage: store, native: false });
    await expect(auth.renew()).resolves.toBeNull();
    expect(api.loads()).toBe(0);

    await auth.authorize();
    const failed = google((config) => config.error_callback?.({ type: "interaction_required" }));
    const renewing = createDriveAuth({ clientId: CLIENT, load: failed.load, storage: store, native: false });
    await expect(renewing.renew()).resolves.toBeNull();
  });

  it("forgets the token on request", async () => {
    const store = storage();
    const auth = createDriveAuth({ clientId: CLIENT, load: google(success()).load, storage: store, native: false });
    await auth.authorize();
    expect(store.size()).toBe(1);
    auth.forget();
    expect(store.size()).toBe(0);
    expect(auth.current()).toBeNull();
  });
});

/**
 * Android obtains the same narrow grant natively because Google refuses the
 * Identity Services script inside a WebView. The port must apply identical
 * validation there and must never open UI for a background renewal.
 */
function nativeTransport(answer: (options: { silent: boolean }) => Promise<NativeDriveAccess>) {
  const calls: Array<{ silent: boolean }> = [];
  const revoked: string[] = [];
  const transport: NativeDriveAuth = {
    isAvailable: async () => ({ available: true }),
    authorize: async (options) => { calls.push(options); return answer(options); },
    revoke: async ({ token }) => { revoked.push(token); return { revoked: true }; },
  };
  return { transport, calls, revoked };
}

const granted = () => Promise.resolve({ accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 });

describe("connecting a Google account on Android", () => {
  it("connects through the native grant and stores it like the web token", async () => {
    const native = nativeTransport(granted);
    const auth = createDriveAuth({ native: true, transport: native.transport, storage: storage() });
    expect(auth.available()).toBe(true);
    expect(auth.unavailableReason()).toBeNull();
    await expect(auth.authorize()).resolves.toMatchObject({ token: TOKEN });
    expect(native.calls).toEqual([{ silent: false }]);
    expect(auth.current()?.token).toBe(TOKEN);
  });

  it("still fails closed when the build has no native grant at all", async () => {
    const auth = createDriveAuth({ native: true, transport: null, storage: storage() });
    expect(auth.available()).toBe(false);
    expect(auth.unavailableReason()).toBe("native");
    await expect(auth.authorize()).rejects.toMatchObject({ kind: "native" });
  });

  it("does not resolve a plugin the bridge cannot confirm exists", () => {
    // Reachable through the real default path: no explicit `transport`, a
    // native platform, and a bridge without `isPluginAvailable`. Resolving
    // `registerPlugin` here would offer a backup the build may not have.
    const auth = createDriveAuth({ storage: storage() });
    expect(auth.available()).toBe(false);
    expect(auth.unavailableReason()).toBe("native");
    expect(() => auth.current()).not.toThrow();
  });

  it("reports a native refusal as a refusal, not a generic failure", async () => {
    const native = nativeTransport(async () => {
      throw Object.assign(new Error("dismissed"), { code: "denied" });
    });
    const auth = createDriveAuth({ native: true, transport: native.transport, storage: storage() });
    await expect(auth.authorize()).rejects.toMatchObject({ kind: "denied" });
    expect(auth.current()).toBeNull();
  });

  it("refuses a native answer Google could not have sent", async () => {
    const answers: NativeDriveAccess[] = [
      { accessToken: "short", expiresAt: Date.now() + 3_600_000 },
      { accessToken: TOKEN, expiresAt: Date.now() - 1_000_000 },
      { accessToken: TOKEN, expiresAt: Number.NaN },
    ];
    for (const answer of answers) {
      const native = nativeTransport(async () => answer);
      const auth = createDriveAuth({ native: true, transport: native.transport, storage: storage() });
      await expect(auth.authorize()).rejects.toBeInstanceOf(DriveAuthError);
      expect(auth.current()).toBeNull();
    }
  });

  it("keeps a background renewal silent: a needed consent yields no token", async () => {
    const store = storage();
    const connected = nativeTransport(granted);
    const auth = createDriveAuth({ native: true, transport: connected.transport, storage: store });
    await auth.authorize();

    const needsConsent = nativeTransport(async () => {
      throw Object.assign(new Error("consent"), { code: "consent-required" });
    });
    const renewing = createDriveAuth({ native: true, transport: needsConsent.transport, storage: store });
    await expect(renewing.renew()).resolves.toBeNull();
    expect(needsConsent.calls).toEqual([{ silent: true }]);
  });

  it("revokes the Google grant when the user disconnects", async () => {
    const store = storage();
    const native = nativeTransport(granted);
    const auth = createDriveAuth({ native: true, transport: native.transport, storage: store });
    await auth.authorize();
    auth.forget();
    expect(auth.current()).toBeNull();
    expect(store.size()).toBe(0);
    expect(native.revoked).toEqual([TOKEN]);
  });
});
