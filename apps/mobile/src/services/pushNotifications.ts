import { registerPlugin } from "@capacitor/core";
import { reportLink } from "../utils/reportLinks";
import { registerDeviceToken, unregisterDeviceToken, type PushPlatform } from "./deviceTokens";
import { parseChatPush } from "./chatPush";

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
  /** Android cached admission only; called by the canonical auth/push owner. */
  setChatAccount?(accountId: string | null): Promise<void>;
  takeChatTap?(accountId: string): Promise<unknown>;
  acknowledgeChatTap?(accountId: string, notificationId: string): Promise<void>;
  onChatTap?(cb: () => void): Promise<() => void>;
}

export interface PushControllerOptions {
  adapter: PushAdapter;
  /** Canonical runtime's live auth-owner guard, including explicit settings starts. */
  isCurrent?: () => boolean;
  registerToken?: (token: string, platform: PushPlatform) => Promise<void>;
  /** Test seam; defaults to the auth.uid()-scoped unregister RPC. */
  unregisterToken?: (token: string) => Promise<void>;
  onRegistrationError?: (message: string) => void;
  /** Test seam; defaults to dispatching the report-link window event. */
  openReportUrl?: (url: string) => void;
  /** Test seam; defaults to dispatching the received window event. */
  emitReceived?: () => void;
  chatAccount?: () => string | null;
  chatWake?: (accountId: string) => void;
}

/** A report URL from a push data payload, or null when there is nothing to open. */
export function reportUrlFromPushData(data: Record<string, string | undefined>): string | null {
  if (data.type?.startsWith("CHAT_")) return null;
  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (url) return url;
  const postId = typeof data.postId === "string" ? data.postId.trim() : "";
  return postId ? reportLink(postId) : null;
}

/**
 * What a teardown actually achieved. The device may hold no registration at
 * all, or a registration that could not be released — the caller must be able
 * to tell the difference instead of assuming the device is unregistered.
 */
export interface PushTeardown {
  /** This device holds no live push registration any more. */
  unregistered: boolean;
  /** A registration existed and was released. */
  released: boolean;
}

export interface PushStartOptions {
  /** Only an explicit consumer Enable action may request OS permission. */
  requestPermission?: boolean;
  /** Auth-owner guard, rechecked at every asynchronous boundary and callback. */
  isCurrent?: () => boolean;
  /** Preference admission runs before native work, but is fenced by stop(). */
  prepare?: () => Promise<boolean>;
}

export interface PushController {
  start(options?: PushStartOptions): Promise<PushPermissionState>;
  stop(): Promise<PushTeardown>;
  isRunning(): boolean;
  /** Current OS permission state without prompting; "unsupported" on web. */
  permission(): Promise<PushPermissionState>;
  /** Opens OS notification settings; rejects when unavailable. */
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
  let generation = 0;
  let pendingRegistration: Promise<void> = Promise.resolve();
  let nativeQueue: Promise<unknown> = Promise.resolve();
  let starting: Promise<PushPermissionState> | null = null;
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = nativeQueue.then(work);
    nativeQueue = result.catch(() => {});
    return result;
  };

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
      if (!adapter.openSettings) throw new Error("Notification settings aren't available here.");
      await adapter.openSettings();
    },

    start(startOptions = {}): Promise<PushPermissionState> {
      if (!adapter.isNative()) return Promise.resolve("unsupported");
      if (starting) return starting;
      if (running) return Promise.resolve("granted");
      const epoch = generation;
      const active = () => epoch === generation && (options.isCurrent?.() ?? true) && (startOptions.isCurrent?.() ?? true);
      const attempt = (async (): Promise<PushPermissionState> => {
        if (startOptions.prepare && !await startOptions.prepare()) return "prompt";
        if (!active()) return "prompt";
        return serialize(async (): Promise<PushPermissionState> => {
          try {
            if (!active()) return "prompt";
            let permission = await adapter.checkPermission?.() ?? "prompt";
            if (!active()) return "prompt";
            if (permission !== "granted" && startOptions.requestPermission === true) {
              permission = await adapter.requestPermission();
            }
            if (!active()) return "prompt";
            if (permission !== "granted") return permission;
            const listen = async (listener: Promise<() => void>) => {
              const cleanup = await listener;
              if (!active()) cleanup();
              else cleanups.push(cleanup);
            };

            await listen(adapter.onRegistration(async (token) => {
              if (!active()) return;
              const trimmed = token?.trim();
              if (!trimmed) return;
              currentToken = trimmed;
              pendingRegistration = pendingRegistration.then(async () => {
                if (!active()) return;
                try {
                  await (options.registerToken ?? registerDeviceToken)(trimmed, adapter.platform());
                } catch (error) {
                  options.onRegistrationError?.(error instanceof Error ? error.message : "token registration failed");
                }
              });
              await pendingRegistration;
            }));
            await listen(adapter.onRegistrationError((message) => {
              if (active()) options.onRegistrationError?.(message);
            }));
            await listen(adapter.onReceived((data) => {
              if (!active()) return;
              if (data.type?.startsWith("CHAT_")) {
                const chat = parseChatPush(data);
                if (chat && chat.recipientId === options.chatAccount?.()) options.chatWake?.(chat.recipientId);
                return;
              }
              emitReceived();
            }));
            await listen(adapter.onAction((data) => {
              if (!active()) return;
              // Chat taps never trust Capacitor's exported-launcher extras.
              // Only the app-private pending action bridge may route them.
              if (data.type?.startsWith("CHAT_")) return;
              const url = reportUrlFromPushData(data);
              if (url) openReportUrl(url);
            }));
            if (!active()) return "prompt";
            await adapter.register();
            if (!active()) return "prompt";
            running = true;
            return "granted";
          } catch (error) {
            // Retried starts must never leave an old listener able to register.
            if (epoch === generation) ++generation;
            for (const cleanup of cleanups.splice(0)) cleanup();
            throw error;
          }
        });
      })();
      starting = attempt;
      void attempt.finally(() => { if (starting === attempt) starting = null; }).catch(() => {});
      return attempt;
    },

    async stop(): Promise<PushTeardown> {
      if (!adapter.isNative()) return { unregistered: true, released: false };
      ++generation;
      starting = null;
      running = false;
      return serialize(async () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        await pendingRegistration;
        // Auth's intentional cleanup awaits stop before releasing its session.
        const token = currentToken;
        let unregistered = !token;
        if (token) try {
          await (options.unregisterToken ?? unregisterDeviceToken)(token);
          unregistered = true;
          currentToken = null;
        } catch {
          /* retain the token so a failed server cleanup can be retried */
        }
        let deviceReleased = true;
        try {
          await adapter.deleteToken?.();
        } catch {
          deviceReleased = false;
        }
        return { unregistered: unregistered && deviceReleased, released: unregistered && deviceReleased && token !== null };
      });
    },
  };
}

/** The dynamically-imported plugin handle. Type-only, so it adds no bundle weight. */
type PushPlugin = (typeof import("@capacitor/push-notifications"))["PushNotifications"];

/** Default Capacitor-backed adapter. Loaded lazily so web/tests stay inert. */
export function createCapacitorPushAdapter(): PushAdapter {
  const native = () =>
    typeof window !== "undefined" && "Capacitor" in window &&
    Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  const platform = (): PushPlatform => {
    const p = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    return p === "ios" || p === "android" ? (p as PushPlatform) : "web";
  };
  /**
   * Deferred import keeps the plugin out of the web bundle graph at load time.
   *
   * The plain-object wrapper is load-bearing, not ceremony. Capacitor's
   * `registerPlugin` proxy turns unknown properties, including `then`, into
   * method wrappers. Promise resolution invokes `.then` on any thenable: an
   * async loader returning the proxy therefore invokes its unsupported `then`.
   * Capacitor's discarded inner promise rejects, while the awaited loader never
   * settles, so a surrounding try/catch cannot recover. Resolving with an object
   * that merely holds the proxy avoids that lookup. The adapter regression tests
   * exercise the installed Capacitor runtime, replacing only the OS bridge.
   */
  const plugin = async (): Promise<{ p: PushPlugin }> => ({
    p: (await import("@capacitor/push-notifications")).PushNotifications,
  });
  const settingsPlugin = () =>
    registerPlugin<{
      openSettings(): Promise<void>;
      setChatAccount(options: { accountId: string | null }): Promise<void>;
      takeChatTap(options: { accountId: string }): Promise<{ data?: unknown }>;
      acknowledgeChatTap(options: { accountId: string; notificationId: string }): Promise<void>;
      addListener(event: "chatTapAvailable", cb: () => void): Promise<{ remove(): Promise<void> }>;
    }>("FindbackNotifications");

  return {
    isNative: native,
    platform,
    async setChatAccount(accountId) {
      if (native() && platform() === "android") await settingsPlugin().setChatAccount({ accountId });
    },
    async takeChatTap(accountId) {
      if (!native() || platform() !== "android") return null;
      return (await settingsPlugin().takeChatTap({ accountId })).data ?? null;
    },
    async acknowledgeChatTap(accountId, notificationId) {
      if (native() && platform() === "android") await settingsPlugin().acknowledgeChatTap({ accountId, notificationId });
    },
    async onChatTap(cb) {
      if (!native() || platform() !== "android") return () => {};
      const handle = await settingsPlugin().addListener("chatTapAvailable", cb);
      return () => { void handle.remove(); };
    },
    async requestPermission() {
      const result = await (await plugin()).p.requestPermissions();
      return result.receive === "granted" ? "granted" : result.receive === "denied" ? "denied" : "prompt";
    },
    async checkPermission() {
      const result = await (await plugin()).p.checkPermissions();
      return result.receive === "granted" ? "granted" : result.receive === "denied" ? "denied" : "prompt";
    },
    async openSettings() {
      await settingsPlugin().openSettings();
    },
    async register() {
      await (await plugin()).p.register();
    },
    async deleteToken() {
      await (await plugin()).p.unregister();
    },
    async onRegistration(cb) {
      const handle = await (await plugin()).p.addListener("registration", (token) => cb(token.value));
      return () => void handle.remove();
    },
    async onRegistrationError(cb) {
      const handle = await (await plugin()).p.addListener("registrationError", (error) =>
        cb(typeof error?.error === "string" ? error.error : "registration error"),
      );
      return () => void handle.remove();
    },
    async onReceived(cb) {
      const handle = await (await plugin()).p.addListener("pushNotificationReceived", (notification) =>
        cb((notification.data ?? {}) as Record<string, string>),
      );
      return () => void handle.remove();
    },
    async onAction(cb) {
      const handle = await (await plugin()).p.addListener("pushNotificationActionPerformed", (action) =>
        cb((action.notification.data ?? {}) as Record<string, string>),
      );
      return () => void handle.remove();
    },
  };
}
