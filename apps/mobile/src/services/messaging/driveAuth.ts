/**
 * Google authorization for the optional Drive backup, kept deliberately apart
 * from Norfold sign-in.
 *
 * The backup Google identity may differ from the Norfold account, and connecting
 * it must never become a Norfold login method: this module only ever requests
 * the narrow `drive.appdata` scope and never feeds a Google token to Supabase.
 *
 * On the web we use Google Identity Services' token model, which needs no
 * redirect route and no stored refresh token. Tokens are short-lived, kept in
 * memory (mirrored in `sessionStorage` so a reload does not force a re-consent)
 * and never exported anywhere else.
 *
 * Inside the Android WebView Google blocks embedded authorization, so the
 * Android build gets the same narrow grant from the native `DriveAuth` plugin
 * instead (`Identity.getAuthorizationClient`) and shares the identical
 * validation, storage and renewal contract. The port reports unavailable only
 * when neither path exists, rather than pretending to be connected.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const DRIVE_TOKEN_KEY = "norfold.drive.token.v1";
/** Refresh a minute early so a request never races the expiry. */
const SKEW_MS = 60_000;

export type DriveAuthUnavailable = "native" | "unconfigured";

export class DriveAuthError extends Error {
  constructor(public kind: "denied" | "failed" | DriveAuthUnavailable) {
    super(kind === "denied" ? "Google Drive access was not granted."
      : kind === "native" ? "Drive backup isn't available on this device."
        : kind === "unconfigured" ? "Drive backup isn't configured for this build."
          : "Google Drive could not be reached. Try again.");
    this.name = "DriveAuthError";
  }
}

export interface DriveAccess { token: string; expiresAt: number }

/**
 * The native Android half. The WebView cannot run Google Identity Services, so
 * `DriveAuthPlugin` performs the same single-scope grant with Play services and
 * returns only the access token and its conservative local expiry.
 */
export interface NativeDriveAccess { accessToken: string; expiresAt: number; account?: string }

export interface NativeDriveAuth {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  authorize(options: { silent: boolean }): Promise<NativeDriveAccess>;
  revoke(options: { token: string }): Promise<{ revoked?: boolean }>;
}

const DRIVE_PLUGIN = "DriveAuth";
let nativeBridge: NativeDriveAuth | null = null;

/** The registered Android plugin, or null when this build has no such path. */
function driveBridge(): NativeDriveAuth | null {
  if (!Capacitor.isNativePlatform()) return null;
  // Fail closed when the bridge cannot report plugin availability: without that
  // check there is no way to prove the plugin is installed, and claiming it is
  // would offer a backup the device cannot honour.
  if (typeof Capacitor.isPluginAvailable !== "function") return null;
  if (!Capacitor.isPluginAvailable(DRIVE_PLUGIN)) return null;
  nativeBridge ??= registerPlugin<NativeDriveAuth>(DRIVE_PLUGIN);
  return nativeBridge;
}

/** Native rejections carry a stable `code`; never surface platform text. */
function nativeFailure(error: unknown): DriveAuthError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "denied") return new DriveAuthError("denied");
  if (code === "unavailable") return new DriveAuthError("native");
  if (code === "misconfigured") return new DriveAuthError("unconfigured");
  return new DriveAuthError("failed");
}

export interface DriveAuthorization {
  /** A real build can connect; false means the UI must not offer it. */
  available(): boolean;
  unavailableReason(): DriveAuthUnavailable | null;
  /** Requires a user gesture. */
  authorize(): Promise<DriveAccess>;
  /** Silent renewal; resolves null when Google needs a gesture again. */
  renew(): Promise<DriveAccess | null>;
  /** The still-valid token, or null. */
  current(): DriveAccess | null;
  forget(): void;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}
interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}
interface GoogleOAuth2 {
  initTokenClient(config: { client_id: string; scope: string;
    callback(response: TokenResponse): void;
    error_callback?(error: { type?: string; message?: string }): void }): TokenClient;
}
interface GoogleIdentity { accounts: { oauth2: GoogleOAuth2 } }

const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

function validAccess(value: unknown, now: number): DriveAccess | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.token !== "string" || !TOKEN.test(entry.token)) return null;
  if (typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt)) return null;
  return entry.expiresAt - SKEW_MS > now ? { token: entry.token, expiresAt: entry.expiresAt } : null;
}

/** Load GIS lazily — registering for backup must never load Google on login. */
function loadGoogleIdentity(document: Document): Promise<GoogleOAuth2> {
  const existing = (globalThis as { google?: GoogleIdentity }).google?.accounts?.oauth2;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const loaded = (globalThis as { google?: GoogleIdentity }).google?.accounts?.oauth2;
      if (loaded) resolve(loaded);
      else reject(new DriveAuthError("failed"));
    };
    script.onerror = () => {
      script.remove();
      reject(new DriveAuthError("failed"));
    };
    document.head.append(script);
  });
}

export interface DriveAuthOptions {
  clientId?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  native?: boolean;
  load?: () => Promise<GoogleOAuth2>;
  /** Android plugin seam; `undefined` resolves the registered plugin. */
  transport?: NativeDriveAuth | null;
}

export function driveClientId(): string {
  const value = import.meta.env?.VITE_GOOGLE_DRIVE_CLIENT_ID;
  return typeof value === "string" ? value.trim() : "";
}

export function createDriveAuth(options: DriveAuthOptions = {}): DriveAuthorization {
  const clientId = options.clientId ?? driveClientId();
  const native = options.native ?? Capacitor.isNativePlatform();
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined
    ? (typeof sessionStorage === "undefined" ? null : sessionStorage)
    : options.storage;
  const load = options.load ?? (() => loadGoogleIdentity(document));
  const transport = options.transport === undefined ? driveBridge() : options.transport;
  let live: DriveAccess | null = null;
  let loaded = false;

  const read = (): DriveAccess | null => {
    if (live) {
      const valid = validAccess(live, now());
      if (valid) return valid;
      live = null;
      storage?.removeItem(DRIVE_TOKEN_KEY);
    }
    if (!storage) return null;
    const raw = storage.getItem(DRIVE_TOKEN_KEY);
    if (!raw) return null;
    try {
      const parsed = validAccess(JSON.parse(raw), now());
      if (!parsed) storage.removeItem(DRIVE_TOKEN_KEY);
      return parsed;
    } catch {
      storage.removeItem(DRIVE_TOKEN_KEY);
      return null;
    }
  };

  const save = (access: DriveAccess): void => {
    live = access;
    storage?.setItem(DRIVE_TOKEN_KEY, JSON.stringify(access));
  };

  const unavailableReason = (): DriveAuthUnavailable | null => {
    // A native build is usable once the Drive plugin is registered; the web
    // token client is the alternative, but it cannot run inside a WebView.
    if (native) return transport ? null : "native";
    if (!clientId) return "unconfigured";
    if (typeof document === "undefined") return "unconfigured";
    return null;
  };

  /** One native grant, validated by the same rules as the web token. */
  const askNative = async (silent: boolean): Promise<DriveAccess | null> => {
    if (!transport) throw new DriveAuthError("native");
    let answer: NativeDriveAccess;
    try {
      answer = await transport.authorize({ silent });
    } catch (error) {
      throw nativeFailure(error);
    }
    const access = validAccess(
      { token: answer?.accessToken ?? "", expiresAt: Number(answer?.expiresAt ?? 0) }, now());
    if (!access) throw new DriveAuthError("failed");
    save(access);
    loaded = true;
    return access;
  };

  const request = (silent: boolean): Promise<DriveAccess | null> => {
    const reason = unavailableReason();
    if (reason) return Promise.reject(new DriveAuthError(reason));
    if (native) return askNative(silent);
    return load().then((oauth2) => new Promise<DriveAccess | null>((resolve, reject) => {
      let settled = false;
      const finish = (access: DriveAccess | null, error?: DriveAuthError) => {
        if (settled) return;
        settled = true;
        if (error) { if (silent) resolve(null); else reject(error); }
        else resolve(access);
      };
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          const token = typeof response.access_token === "string" ? response.access_token : "";
          const expires = typeof response.expires_in === "number" ? response.expires_in : 0;
          if (!TOKEN.test(token) || !Number.isFinite(expires) || expires < 1 || expires > 86_400) {
            finish(null, new DriveAuthError(response.error ? "denied" : "failed"));
            return;
          }
          const access = { token, expiresAt: now() + Math.round(expires * 1000) };
          save(access);
          finish(access);
        },
        error_callback: (error) => {
          // `interaction_required`/`access_denied` mean Google wants a gesture;
          // a silent attempt reports null rather than an error the UI must show.
          finish(null, new DriveAuthError(error?.type === "access_denied" ? "denied" : "failed"));
        },
      });
      try {
        client.requestAccessToken({ prompt: "" });
        loaded = true;
      } catch {
        finish(null, new DriveAuthError("failed"));
      }
    }));
  };

  return {
    available: () => unavailableReason() === null,
    unavailableReason,
    authorize: async () => {
      const access = await request(false);
      if (!access) throw new DriveAuthError("failed");
      return access;
    },
    renew: async () => {
      // A silent renewal is only worth trying for a grant the user already
      // made: on the web it would otherwise inject the GIS script for someone
      // who declined, and on Android it would open a consent sheet.
      if (!loaded && !read()) return null;
      try {
        return await request(true);
      } catch {
        return null;
      }
    },
    current: read,
    forget: () => {
      const last = read();
      live = null;
      storage?.removeItem(DRIVE_TOKEN_KEY);
      // Revoking the Google grant is best-effort: the local token is gone
      // either way, so a device that is offline still reports disconnected.
      if (native && transport && last) {
        void Promise.resolve(transport.revoke({ token: last.token })).catch(() => undefined);
      }
    },
  };
}

/** The one process-wide port; tests build their own with `createDriveAuth`. */
let shared: DriveAuthorization | null = null;
export function driveAuth(): DriveAuthorization {
  shared ??= createDriveAuth();
  return shared;
}
