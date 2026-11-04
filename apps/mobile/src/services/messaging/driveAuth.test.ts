// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DRIVE_SCOPE,
  DRIVE_TOKEN_KEY,
  DriveAuthError,
  createDriveAuth,
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
