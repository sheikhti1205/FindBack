import { registerPlugin } from "@capacitor/core";
import { reportLink } from "../utils/reportLinks";
import { registerDeviceToken, unregisterDeviceToken, type PushPlatform } from "./deviceTokens";

export type PushPermissionState = "granted" | "denied" | "prompt" | "unsupported";

/**
 * Android notification channels are owned natively (`PushChannels` /
 * `FindbackApp.onCreate`): one channel per category under the "FindBack" group,
 * created before the first push so Android Settings shows them immediately.
 * The JS layer deliberately does not create channels.
 */
export const FINDBACK_PUSH_CHANNEL_GROUP = "findback";
export const FINDBACK_PUSH_CHANNELS = {
  comments: "findback.comments.v1",
  activity: "findback.activity.v1",
  updates: "findback.updates.v1",
} as const;

/** Window event fired when a push arrives while the app is foregrounded. */
export const PUSH_RECEIVED_EVENT = "findback:notification-received";
/** Window event fired with a report URL when a notification is tapped. */
export const PUSH_REPORT_LINK_EVENT = "findback:report-link";

export interface PushAdapter {
  isNative(): boolean;
  platform(): PushPlatform;
  requestPermission(): Promise<Exclude<PushPermissionState, "unsupported">>;
  register(): Promise<void>;
  /** Current OS permission, without prompting. */
  checkPermission?(): Promise<PushPermissionState>;
  /** Opens the OS notification settings for recovery after a denial. */
  openSettings?(): Promise<void>;
  onRegistration(cb: (token: string) => void): Promise<() => void>;
  onRegistrationError(cb: (message: string) => void): Promise<() => void>;
  onReceived(cb: (data: Record<string, string>) => void): Promise<() => void>;
  onAction(cb: (data: Record<string, string>) => void): Promise<() => void>;
  /** Deletes the FCM registration token on the device; absent on web/test fakes. */
  deleteToken?(): Promise<void>;
}

export interface PushControllerOptions {
  adapter: PushAdapter;
  registerToken?: (token: string, platform: PushPlatform) => Promise<void>;
  /** Test seam; defaults to the auth.uid()-scoped unregister RPC. */
  unregisterToken?: (token: string) => Promise<void>;
  onRegistrationError?: (message: string) => void;
  /** Test seam; defaults to dispatching the report-link window event. */
  openReportUrl?: (url: string) => void;
  /** Test seam; defaults to dispatching the received window event. */
  emitReceived?: () => void;
}

/** A report URL from a push data payload, or null when there is nothing to open. */
export function reportUrlFromPushData(data: Record<string, string | undefined>): string | null {
  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (url) return url;
  const postId = typeof data.postId === "string" ? data.postId.trim() : "";
  return postId ? reportLink(postId) : null;
}

export interface PushController {
  start(): Promise<PushPermissionState>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** Current OS permission state without prompting; "unsupported" on web. */
  permission(): Promise<PushPermissionState>;
  /** Opens OS notification settings; no-op when the adapter cannot. */
  openSettings(): Promise<void>;
}

/**
 * Owns the FCM lifecycle: channel setup, permission, token registration and
 * tap/receive routing. All Capacitor calls go through the injected adapter so
 * the controller is unit-testable on the JVM and inert on the web.
 */
export function createPushController(options: PushControllerOptions): PushController {
  const { adapter } = options;
  const cleanups: Array<() => void> = [];
  let running = false;
  let currentToken: string | null = null;

  const emitReceived =
    options.emitReceived ??
    (() => {
      window.dispatchEvent(new CustomEvent(PUSH_RECEIVED_EVENT));
    });
  const openReportUrl =
    options.openReportUrl ??
    ((url: string) => {
      window.dispatchEvent(new CustomEvent(PUSH_REPORT_LINK_EVENT, { detail: url }));
    });

  return {
    isRunning: () => running,

    async permission(): Promise<PushPermissionState> {
      if (!adapter.isNative()) return "unsupported";
      if (adapter.checkPermission) return adapter.checkPermission();
      return running ? "granted" : "prompt";
    },

    async openSettings(): Promise<void> {
      await adapter.openSettings?.();
    },

    async start(): Promise<PushPermissionState> {
      if (!adapter.isNative()) return "unsupported";
      if (running) return "granted";
      const permission = await adapter.requestPermission();
      if (permission !== "granted") return permission;

      cleanups.push(
        await adapter.onRegistration(async (token) => {
          const trimmed = token?.trim();
          if (!trimmed) return;
          currentToken = trimmed;
          try {
            await (options.registerToken ?? registerDeviceToken)(trimmed, adapter.platform());
          } catch (error) {
            options.onRegistrationError?.(error instanceof Error ? error.message : "token registration failed");
          }
        }),
      );
      cleanups.push(
        await adapter.onRegistrationError((message) => options.onRegistrationError?.(message)),
      );
      cleanups.push(await adapter.onReceived(() => emitReceived()));
      cleanups.push(
        await adapter.onAction((data) => {
          const url = reportUrlFromPushData(data);
          if (url) openReportUrl(url);
        }),
      );
      await adapter.register();
      running = true;
      return "granted";
    },

    async stop(): Promise<void> {
      for (const cleanup of cleanups.splice(0)) cleanup();
      // Unregister while the session is still valid so a logged-out or
      // switched account can never keep receiving this device's pushes.
      if (currentToken) {
        const token = currentToken;
        currentToken = null;
        try {
          await (options.unregisterToken ?? unregisterDeviceToken)(token);
        } catch {
          /* server cleanup is best-effort; the token row is transferred on next sign-in */
        }
        try {
          await adapter.deleteToken?.();
        } catch {
          /* deleting the device token is best-effort */
        }
      }
      running = false;
    },
  };
}

/** Default Capacitor-backed adapter. Loaded lazily so web/tests stay inert. */
export function createCapacitorPushAdapter(): PushAdapter {
  const native = () =>
    typeof window !== "undefined" && "Capacitor" in window &&
    Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  const platform = (): PushPlatform => {
    const p = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    return p === "ios" || p === "android" ? (p as PushPlatform) : "web";
  };
  // Deferred import keeps the plugin out of the web bundle graph at load time.
  const plugin = async () => (await import("@capacitor/push-notifications")).PushNotifications;
  const settingsPlugin = () =>
    registerPlugin<{ openSettings(): Promise<void> }>("FindbackNotifications");

  return {
    isNative: native,
    platform,
    async requestPermission() {
      const result = await (await plugin()).requestPermissions();
      return result.receive === "granted" ? "granted" : result.receive === "denied" ? "denied" : "prompt";
    },
    async checkPermission() {
      const result = await (await plugin()).checkPermissions();
      return result.receive === "granted" ? "granted" : result.receive === "denied" ? "denied" : "prompt";
    },
    async openSettings() {
      await settingsPlugin().openSettings();
    },
    async register() {
      await (await plugin()).register();
    },
    async deleteToken() {
      await (await plugin()).unregister();
    },
    async onRegistration(cb) {
      const handle = await (await plugin()).addListener("registration", (token) => cb(token.value));
      return () => void handle.remove();
    },
    async onRegistrationError(cb) {
      const handle = await (await plugin()).addListener("registrationError", (error) =>
        cb(typeof error?.error === "string" ? error.error : "registration error"),
      );
      return () => void handle.remove();
    },
    async onReceived(cb) {
      const handle = await (await plugin()).addListener("pushNotificationReceived", (notification) =>
        cb((notification.data ?? {}) as Record<string, string>),
      );
      return () => void handle.remove();
    },
    async onAction(cb) {
      const handle = await (await plugin()).addListener("pushNotificationActionPerformed", (action) =>
        cb((action.notification.data ?? {}) as Record<string, string>),
      );
      return () => void handle.remove();
    },
  };
}
