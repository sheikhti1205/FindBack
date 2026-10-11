import { useCallback, useEffect, useState } from "react";
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
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermissionState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchNotificationPreferences()
      .then((next) => {
        if (!cancelled) setPrefs(next);
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyError(err).message);
      });
    pushController()
      .permission()
      .then((state) => {
        if (!cancelled) setPermission(state);
      })
      .catch(() => {
        if (!cancelled) setPermission(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enableDeviceNotifications = useCallback(async () => {
    setBusy(true);
    try {
      const state = await pushController().start();
      setPermission(state);
    } catch {
      setPermission("denied");
    } finally {
      setBusy(false);
    }
  }, []);

  const openSystemSettings = useCallback(async () => {
    try {
      await pushController().openSettings();
    } catch {
      /* recovery path is best-effort */
    }
  }, []);

  const toggle = useCallback(
    async (key: keyof NotificationPreferences, value: boolean) => {
      const previous = prefs ?? DEFAULT_NOTIFICATION_PREFERENCES;
      const next = { ...previous, [key]: value };
      setPrefs(next);
      setError(null);
      try {
        await saveNotificationPreferences(next);
      } catch (err) {
        setPrefs(previous);
        setError(friendlyError(err).message);
      }
    },
    [prefs],
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
      disabled={disabled}
      onChange={(value) => void toggle(key, value)}
    />
  );

  return (
    <div className="flex flex-col gap-1 py-2">
      {permission && permission !== "unsupported" ? (
        <section className="mb-1 rounded-m3-xs border border-outline-variant p-3" aria-label="Device notifications">
          {permission === "granted" ? (
            <p className="text-xs text-on-surface-variant">Device notifications are on for this phone.</p>
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
        <p role="alert" className="px-1 pt-1 text-xs text-error">{error}</p>
      ) : null}
    </div>
  );
}
