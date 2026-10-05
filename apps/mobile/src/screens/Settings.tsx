import { useEffect, useState } from "react";
import {
  Activity,
  Bell,
  CircleHelp,
  Image,
  Info,
  KeyRound,
  LogOut,
  Palette,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Accessibility,
} from "lucide-react";
import { useAuth } from "../auth";
import {
  ACCENT_OPTIONS,
  TEXT_SCALE_OPTIONS,
  useAppearance,
  type AccentId,
  type ReduceMotionOverride,
  type TextScaleId,
} from "../appearance";
import { useTheme, type Theme } from "../theme";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSearch,
} from "../components/settings";
import { AccountSummaryCard } from "../components/AccountSummaryCard";
import { searchSettings } from "../services/settingsIndex";
import { type AssistantMode } from "./AiModels";
import { loadEffectiveAssistantMode } from "../services/ai/aiPreferences";
import { fetchNotificationPreferences, type NotificationPreferences } from "../services/notificationPreferences";
import { pushController } from "../services/pushRuntime";
import type { PushPermissionState } from "../services/pushNotifications";
import { describeCloudConnections } from "../services/aiCredentials";
import { APP_VERSION } from "../services/appCapabilities";
import { friendlyError } from "../utils/friendlyErrors";
import "./Settings.css";

const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  amoled: "AMOLED",
};

const MOTION_LABELS: Record<ReduceMotionOverride, string> = {
  system: "System",
  reduce: "Reduced",
  full: "Full",
};

/** Live theme + accent, e.g. `AMOLED · Emerald`. */
export function appearanceSummary(theme: Theme, accent: AccentId): string {
  const accentLabel = ACCENT_OPTIONS.find((option) => option.id === accent)?.label ?? accent;
  return `${THEME_LABELS[theme]} · ${accentLabel}`;
}

/** Live text scale + motion override, e.g. `Default text · System motion`. */
export function accessibilitySummary(textScale: TextScaleId, reduceMotion: ReduceMotionOverride): string {
  const textLabel =
    TEXT_SCALE_OPTIONS.find((option) => option.id === textScale)?.label ?? textScale;
  return `${textLabel} text · ${MOTION_LABELS[reduceMotion]} motion`;
}

/** Live photo-quality flag. */
export function mediaSummary(highQualityPhoto: boolean): string {
  return highQualityPhoto ? "High quality" : "Standard";
}

/**
 * Stored prefs win; OS permission fills the gap; otherwise an honest
 * fallback — never a guessed value.
 */
export function notificationSummary(
  prefs: Pick<NotificationPreferences, "pushEnabled"> | null,
  permission: PushPermissionState | null,
): string {
  if (prefs) return prefs.pushEnabled ? "On" : "Off";
  switch (permission) {
    case "granted":
      return "On";
    case "denied":
      return "Off";
    case "prompt":
      return "Turn on";
    case "unsupported":
      return "Not supported";
    default:
      return "Review settings";
  }
}

/** Fail-closed presence probe: unknown means not connected. */
export function connectionSummary(connected: boolean): string {
  return connected ? "OpenRouter connected" : "Not connected";
}

/**
 * Consumer-tier AI mode labels (match AiSettings MODE_COPY; a legacy stored
 * offline-first value migrates fail-closed to on-device-only, which is an
 * offered mode). Read live from the authoritative aiPreferences store (via
 * the effective gate mode) so the row stays truthful when the mode changes.
 */
const AI_MODE_LABELS: Record<AssistantMode, string> = {
  auto: "Automatic",
  "offline-first": "Offline-first",
  "offline-only": "On-device only",
  "cloud-only": "Cloud only",
};

export function aiModeSummary(mode: AssistantMode): string {
  return AI_MODE_LABELS[mode];
}

/**
 * Settings root: account card, search, exact packet groups, sign-out.
 * Every row targets a real route_map.csv route (detail screens land via
 * tasks E–H/G; the links are in place regardless). Live summaries degrade
 * to honest fallback text when a source is unreadable.
 */
export function Settings() {
  const { user, logout } = useAuth();
  const { theme } = useTheme();
  const { settings } = useAppearance();
  const [query, setQuery] = useState("");
  const [notifValue, setNotifValue] = useState<string | null>(null);
  const [cloudValue, setCloudValue] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<AssistantMode>(() =>
    user ? loadEffectiveAssistantMode(user.id) : "auto",
  );
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await fetchNotificationPreferences();
        if (!cancelled) setNotifValue(notificationSummary(prefs, null));
        return;
      } catch {
        /* fall through to the OS permission probe */
      }
      try {
        const permission = await pushController().permission();
        if (!cancelled) setNotifValue(notificationSummary(null, permission));
      } catch {
        if (!cancelled) setNotifValue(notificationSummary(null, null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (user) setAiMode(loadEffectiveAssistantMode(user.id));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    describeCloudConnections(user.id)
      .then((result) => {
        if (!cancelled) setCloudValue(result.summary);
      })
      .catch(() => {
        // Fail closed: an unreadable slot reads as not connected.
        if (!cancelled) setCloudValue(connectionSummary(false));
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  const trimmed = query.trim();
  const matches = trimmed ? searchSettings(trimmed) : null;

  const handleSignOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    void logout()
      .catch((err: unknown) => {
        setSignOutError(friendlyError(err).message);
      })
      .finally(() => {
        setSigningOut(false);
      });
  };

  return (
    <SettingsPage title="Settings">
      <SettingsSearch
        query={query}
        onQueryChange={setQuery}
        results={matches && matches.length > 0 ? matches : undefined}
      />
      {matches ? (
        matches.length === 0 && (
          <div className="fb-settings-empty">
            <p role="status">No settings found</p>
            <p>Try theme, notifications, AI, privacy, or text size.</p>
          </div>
        )
      ) : (
        <>
          <AccountSummaryCard user={user} />
          <SettingsGroup title="Personalization">
            <SettingsRow
              title="Appearance"
              icon={Palette}
              iconTone="appearance"
              value={appearanceSummary(theme, settings.accent)}
              route="/settings/appearance"
            />
            <SettingsRow
              title="Accessibility"
              icon={Accessibility}
              iconTone="accessibility"
              value={accessibilitySummary(settings.textScale, settings.reduceMotion)}
              route="/settings/accessibility"
            />
            <SettingsRow
              title="Media & uploads"
              icon={Image}
              iconTone="media"
              value={mediaSummary(settings.highQualityPhoto)}
              route="/settings/media"
            />
          </SettingsGroup>
          <SettingsGroup title="Activity">
            <SettingsRow
              title="Notifications"
              icon={Bell}
              iconTone="notifications"
              value={notifValue ?? "Review settings"}
              route="/settings/notifications"
            />
          </SettingsGroup>
          <SettingsGroup title="AI & intelligence">
            <SettingsRow
              title="AI & models"
              icon={Sparkles}
              iconTone="ai"
              value={aiModeSummary(aiMode)}
              route="/settings/ai"
            />
            <SettingsRow
              title="Cloud connections"
              icon={KeyRound}
              iconTone="ai"
              value={cloudValue ?? "Checking…"}
              route="/settings/ai/connections"
            />
          </SettingsGroup>
          <SettingsGroup title="Privacy & app">
            <SettingsRow
              title="Privacy & permissions"
              icon={ShieldCheck}
              iconTone="privacy"
              route="/settings/privacy"
            />
            <SettingsRow
              title="Diagnostics"
              icon={Activity}
              iconTone="privacy"
              route="/settings/diagnostics"
            />
          </SettingsGroup>
          <SettingsGroup title="Support">
            <SettingsRow
              title="Help & guide"
              icon={CircleHelp}
              iconTone="help"
              route="/settings/help"
            />
            <SettingsRow
              title="Replay introduction"
              icon={RotateCcw}
              iconTone="help"
              route="/onboarding?replay=1"
            />
            <SettingsRow
              title="About FindBack"
              icon={Info}
              iconTone="about"
              value={APP_VERSION}
              route="/settings/about"
            />
          </SettingsGroup>
          <div className="fb-settings-signout">
            <SettingsGroup>
              <SettingsRow
                title={signingOut ? "Signing out…" : "Sign out"}
                icon={LogOut}
                destructive
                disabled={signingOut}
                onClick={handleSignOut}
              />
            </SettingsGroup>
            {signOutError && <p role="alert" className="fb-settings-error">{signOutError}</p>}
          </div>
        </>
      )}
    </SettingsPage>
  );
}
