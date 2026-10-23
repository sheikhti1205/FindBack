import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { AtSign, BellRing, Heart, MessageCircle, PackageCheck } from "lucide-react";
import { PreferenceSwitchRow, SettingsGroup } from "./settings";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fetchNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from "../services/notificationPreferences";
import { pushController } from "../services/pushRuntime";
import type { PushPermissionState } from "../services/pushNotifications";
import { friendlyError } from "../utils/friendlyErrors";
import { announce } from "./LiveRegion";

interface ToggleDef {
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
  icon: typeof Heart;
}

const MASTER_TOGGLE: ToggleDef = {
  key: "pushEnabled",
  label: "Push notifications",
  hint: "Send alerts to this device.",
  icon: BellRing,
};

const GROUPS: Array<{ title: string; description: string; toggles: ToggleDef[] }> = [
  {
    title: "Comments & mentions",
    description: "Replies and mentions on your reports.",
    toggles: [
      { key: "comments", label: "Comments", hint: "Someone comments on your report.", icon: MessageCircle },
      { key: "mentions", label: "Mentions", hint: "Someone mentions you in a comment.", icon: AtSign },
    ],
  },
  {
    title: "Report activity",
    description: "Reactions to your reports.",
    toggles: [
      { key: "likes", label: "Reactions", hint: "Someone reacts to your report.", icon: Heart },
    ],
  },
  {
    title: "Report updates",
    description: "Followed reports that change status.",
    toggles: [
      { key: "status", label: "Status updates", hint: "A report you follow changes status.", icon: PackageCheck },
    ],
  },
];

/** Per-user push/notification preferences. Saved on each change (optimistic). */
export function NotificationSettings() {
  const { user } = useAuth();
  return user ? <AccountNotificationSettings key={user.id} /> : null;
}

interface SettingsLifetime { active: boolean }

/** Account-keyed UI lifetime only; auth/session ownership stays in useAuth. */
function AccountNotificationSettings() {
  const lifetime = useRef<SettingsLifetime>({ active: false });
  useLayoutEffect(() => {
    const owner = { active: true };
    lifetime.current = owner;
    // Invalidate before passive effects/microtasks can publish for a new account.
    // A new object on replay also fences StrictMode's first effect generation.
    return () => { owner.active = false; };
  }, []);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermissionState | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Whether this device still holds a live push registration. `null` means
   * unknown — the screen must not claim either state.
   */
  const [deviceRegistered, setDeviceRegistered] = useState<boolean | null>(null);

  useEffect(() => {
    const owner = lifetime.current;
    let cancelled = false;
    fetchNotificationPreferences()
      .then((next) => {
        if (owner.active && !cancelled) setPrefs(next);
      })
      .catch((err) => {
        if (owner.active && !cancelled) setError(friendlyError(err).message);
      });
    pushController()
      .permission()
      .then((state) => {
        if (owner.active && !cancelled) setPermission(state);
      })
      .catch(() => {
        if (owner.active && !cancelled) setPermission(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enableDeviceNotifications = useCallback(async () => {
    const owner = lifetime.current;
    if (!owner.active) return;
    setBusy(true);
    try {
      const state = await pushController().start({ requestPermission: true, isCurrent: () => owner.active });
      if (!owner.active) return;
      setPermission(state);
    } catch {
      if (!owner.active) return;
      const message = "Couldn't turn on alerts for this phone. Please try again.";
      setError(message);
      announce(message);
    } finally {
      if (owner.active) setBusy(false);
    }
  }, []);

  const openSystemSettings = useCallback(async () => {
    const owner = lifetime.current;
    if (!owner.active) return;
    try {
      await pushController().openSettings();
    } catch {
      if (!owner.active) return;
      const message = "Couldn't open notification settings. Open them in your phone's Settings app.";
      setError(message);
      announce(message);
    }
  }, []);

  /**
   * The master switch is the user's "no push on this phone" decision, so it
   * also releases this device's push registration through the canonical push
   * path. Both outcomes are reported honestly: a registration that could not
   * be released is never presented as released, and nothing here prompts for
   * the OS permission behind the user's back.
   */
  const applyDevicePush = useCallback(
    async (enabled: boolean, owner: SettingsLifetime) => {
      if (!owner.active) return;
      if (!enabled) {
        try {
          const result = await pushController().stop();
          if (!owner.active) return;
          if (result.unregistered) {
            setDeviceRegistered(false);
            announce("This phone is no longer registered for push notifications.");
          } else {
            setDeviceRegistered(true);
            setError("Push notifications are off, but this phone is still registered. Try again.");
            announce("Push notifications are off, but this phone is still registered.");
          }
        } catch {
          if (!owner.active) return;
          setDeviceRegistered(null);
          setError("Push notifications are off, but this phone could not be released. Try again.");
          announce("Push notifications are off, but this phone could not be released.");
        }
        return;
      }
      // Turning it back on must not prompt: the OS permission is only
      // requested from the explicit button below, so the device is registered
      // again only when the permission is already granted.
      if (permission !== "granted") {
        setDeviceRegistered(null);
        return;
      }
      try {
        const state = await pushController().start({ requestPermission: false, isCurrent: () => owner.active });
        if (!owner.active) return;
        setPermission(state);
        setDeviceRegistered(null);
      } catch {
        if (!owner.active) return;
        setDeviceRegistered(null);
        setError("Push notifications are on, but this phone could not be registered. Try again.");
        announce("Push notifications are on, but this phone could not be registered.");
      }
    },
    [permission],
  );

  const toggle = useCallback(
    async (key: keyof NotificationPreferences, value: boolean) => {
      const owner = lifetime.current;
      if (busy || !owner.active) return;
      setBusy(true);
      const previous = prefs ?? DEFAULT_NOTIFICATION_PREFERENCES;
      const next = { ...previous, [key]: value };
      setPrefs(next);
      setError(null);
      try {
        await saveNotificationPreferences(next);
      } catch (err) {
        if (!owner.active) return;
        setPrefs(previous);
        setError(friendlyError(err).message);
        setBusy(false);
        return;
      }
      if (!owner.active) return;
      if (key === "pushEnabled") await applyDevicePush(value, owner);
      if (owner.active) setBusy(false);
    },
    [prefs, applyDevicePush, busy],
  );

  if (error && !prefs) {
    return (
      <p role="alert" className="px-3 py-4 text-sm text-on-surface-variant">
        {error}
      </p>
    );
  }
  if (!prefs) {
    return <p role="status" className="px-3 py-4 text-sm text-on-surface-variant">Loading settings…</p>;
  }

  const pushOff = !prefs.pushEnabled;

  const renderToggle = ({ key, label, hint, icon }: ToggleDef, disabled: boolean) => (
    <PreferenceSwitchRow
      key={key}
      title={label}
      description={hint}
      icon={icon}
      iconTone="notifications"
      checked={prefs[key]}
      disabled={disabled || busy}
      onChange={(value) => void toggle(key, value)}
    />
  );

  return (
    <div className="flex flex-col gap-1 py-2">
      {permission && permission !== "unsupported" ? (
        <section className="mb-1 rounded-m3-xs border border-outline-variant p-3" aria-label="Device notifications">
          {pushOff ? (
            <>
              <p className="text-sm font-medium text-on-surface">Push notifications are off</p>
              <p className="mt-1 text-xs text-on-surface-variant">
                {deviceRegistered === false
                  ? "This phone is no longer registered for alerts."
                  : "FindBack won't send push notifications to this phone."}
              </p>
              {permission === "granted" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void openSystemSettings()}
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-on-surface px-4 text-sm font-medium text-surface disabled:opacity-60"
                >
                  Open notification settings
                </button>
              ) : null}
            </>
          ) : permission === "granted" ? (
            <p className="text-xs text-on-surface-variant">Notifications are allowed in your phone settings.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-on-surface">Turn on device notifications?</p>
              <p className="mt-1 text-xs text-on-surface-variant">
                FindBack can alert you to comments, mentions and activity on your reports. Android asks for
                permission only when you tap the button below. The in-app inbox works either way.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void (permission === "denied" ? openSystemSettings() : enableDeviceNotifications())}
                className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-on-surface px-4 text-sm font-medium text-surface disabled:opacity-60"
              >
                {permission === "denied" ? "Open notification settings" : "Enable device notifications"}
              </button>
            </>
          )}
        </section>
      ) : null}
      <SettingsGroup
        title="Push notifications"
        description="Master switch. Turning it off pauses every category below."
      >
        {renderToggle(MASTER_TOGGLE, false)}
      </SettingsGroup>
      {GROUPS.map((group) => (
        <SettingsGroup key={group.title} title={group.title} description={group.description}>
          {group.toggles.map((def) =>
            renderToggle(def, def.key !== "pushEnabled" && pushOff),
          )}
        </SettingsGroup>
      ))}
      {error ? (
        <div>
          <p role="alert" className="px-1 pt-1 text-xs text-error">{error}</p>
          {pushOff && deviceRegistered !== false ? <button type="button" disabled={busy}
            className="min-h-[44px] px-2 text-sm underline"
            onClick={() => void toggle("pushEnabled", false)}>Retry turning off alerts</button> : null}
        </div>
      ) : null}
    </div>
  );
}
