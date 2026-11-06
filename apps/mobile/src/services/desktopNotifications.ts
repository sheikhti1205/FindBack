/**
 * Desktop notifications for the web app.
 *
 * Android already has OS push (FCM through the native shell). A browser tab has
 * no server push here, so this is the honest half of the feature: while Norfold
 * is open — even in a background tab — a new inbox row raises a real operating
 * system notification instead of only bumping the bell.
 *
 * Rules:
 * - The OS permission is requested ONLY from an explicit user action
 *   (Settings → Notifications), never on page load.
 * - The opt-in is per account and device. With no opt-in, or a permission that
 *   is not granted, nothing is shown.
 * - Showing a notification can never throw into the app: an unsupported browser
 *   or a blocked constructor is a silent no-op.
 */

import { Capacitor } from "@capacitor/core";

const STORE_KEY = "norfold:desktop-notifications:v1";

export type DesktopNotificationPermission = "unsupported" | "prompt" | "granted" | "denied";

export interface DesktopNotificationInput {
  title: string;
  body: string;
  /** Stable identity; the OS collapses repeats instead of stacking them. */
  tag?: string;
  onClick?: () => void;
}

function notificationApi(): typeof Notification | null {
  if (Capacitor.isNativePlatform() || typeof window === "undefined" || typeof Notification === "undefined") return null;
  return Notification;
}

export function desktopNotificationsSupported(): boolean {
  return notificationApi() !== null;
}

/** Current OS permission, without ever prompting. */
export function desktopNotificationPermission(): DesktopNotificationPermission {
  const api = notificationApi();
  if (!api) return "unsupported";
  return api.permission === "granted" || api.permission === "denied" ? api.permission : "prompt";
}

function readOptIns(): Record<string, unknown> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** True only when this account opted in AND the OS permission is granted. */
export function desktopNotificationsEnabled(accountId: string): boolean {
  if (desktopNotificationPermission() !== "granted") return false;
  return readOptIns()[accountId] === true;
}

export function setDesktopNotificationsEnabled(accountId: string, enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const optIns = readOptIns();
    if (enabled) optIns[accountId] = true;
    else delete optIns[accountId];
    window.localStorage.setItem(STORE_KEY, JSON.stringify(optIns));
  } catch {
    // Private mode / quota: the OS permission still governs; nothing to persist.
  }
}

/**
 * Ask the browser for notification permission. Call this from a click.
 * Returning the resulting state (never throwing) keeps callers honest: a denied
 * browser stays denied and the UI says so.
 */
export async function requestDesktopNotifications(): Promise<DesktopNotificationPermission> {
  const api = notificationApi();
  if (!api) return "unsupported";
  if (api.permission === "granted" || api.permission === "denied") return api.permission;
  try {
    await api.requestPermission();
  } catch {
    return desktopNotificationPermission();
  }
  return desktopNotificationPermission();
}

const shown = new Set<string>();
const active = new Map<string, Set<Notification>>();

/** Auth teardown closes this account's still-visible system alerts. */
export function closeDesktopNotifications(accountId: string): void {
  for (const notification of active.get(accountId) ?? []) notification.close();
  active.delete(accountId);
}

/** Show one OS notification for this account, or do nothing. Never throws. */
export function showDesktopNotification(accountId: string, input: DesktopNotificationInput): void {
  if (!desktopNotificationsEnabled(accountId)) return;
  const api = notificationApi();
  if (!api) return;
  const tag = input.tag === undefined ? undefined : `${accountId}:${input.tag}`;
  if (tag !== undefined && shown.has(tag)) return;
  try {
    const notification = new api(input.title, {
      body: input.body,
      tag,
      icon: "/icons/findback-192.png",
      badge: "/icons/findback-192.png",
    });
    if (tag !== undefined) {
      shown.add(tag);
      if (shown.size > 64) shown.delete(shown.values().next().value as string);
    }
    const owned = active.get(accountId) ?? new Set<Notification>();
    owned.add(notification); active.set(accountId, owned);
    notification.onclose = () => owned.delete(notification);
    notification.onclick = () => {
      try {
        window.focus();
        input.onClick?.();
      } finally {
        notification.close();
      }
    };
  } catch {
    // Some browsers only allow notifications from a service worker. Nothing in
    // the app depends on this succeeding, so it stays a no-op here.
  }
}

/** Test-only: forget which tags were already shown. */
export function resetDesktopNotificationsForTest(): void {
  shown.clear();
}
