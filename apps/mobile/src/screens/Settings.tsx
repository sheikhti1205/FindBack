import { useEffect, useState } from "react";
import {
  Accessibility,
  Activity,
  Bell,
  CircleHelp,
  Cpu,
  Image,
  Info,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  Palette,
  RotateCcw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  UserRound,
  Users,
} from "lucide-react";
import type { PublicUser } from "@findback/shared";
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
import { SettingsProfileHeader } from "./settings/SettingsProfileHeader";
import { SettingsNestedGroup } from "./settings/SettingsNestedGroup";
import { searchSettings } from "../services/settingsIndex";
import { useFeedLayoutPreference } from "../services/feedLayoutPreference";
import { resolveFeedLayout, useViewportWidth } from "../components/responsive";
import { feedLayoutSummary } from "./FeedLayoutSettings";
import { fetchNotificationPreferences, type NotificationPreferences } from "../services/notificationPreferences";
import { pushController } from "../services/pushRuntime";
import { fetchMyRole, type MyRole } from "../services/roles";
import type { PushPermissionState } from "../services/pushNotifications";
import { APP_VERSION } from "../services/appCapabilities";
import { friendlyError } from "../utils/friendlyErrors";
import "./Settings.css";

const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const MOTION_LABELS: Record<ReduceMotionOverride, string> = {
  system: "System",
  reduce: "Reduced",
  full: "Full",
};

/** Live theme + accent, e.g. `Dark · Emerald`. */
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

/** Live verification state for the Account & verification row. */
export function accountSummary(
  user: Pick<PublicUser, "emailVerified" | "phoneVerified">,
): string {
  if (user.emailVerified && user.phoneVerified) return "Verified";
  if (user.emailVerified || user.phoneVerified) return "Partially verified";
  return "Unverified";
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

/**
 * Settings root: profile header, search, packet groups, sign-out.
 *
 * IA (W4): Account / Preferences / Intelligence / Privacy / More. Moved rows
 * stay one tap away with unchanged routes — Cloud connections lives inside
 * AI & models (`/settings/ai`), Media & uploads and Diagnostics inside the
 * Advanced disclosure, Replay introduction and About inside Help & about —
 * so no destination is orphaned and every row targets a real route.
 * Live summaries degrade to honest fallback text when a source is unreadable.
 */
export function Settings() {
  const { user, logout } = useAuth();
  const { theme } = useTheme();
  const { settings } = useAppearance();
  const { layout: feedLayout } = useFeedLayoutPreference();
  const viewportWidth = useViewportWidth();
  const [query, setQuery] = useState("");
  const [notifValue, setNotifValue] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // The staff console entry is offered only to an account the SERVER says is
  // an ADMIN. An unreadable role leaves it hidden: the server refuses
  // everything an ordinary account asks for, so the client never offers what
  // would be refused. A moderator is staff, but every console destination is
  // admin-only, so a moderator gets no entry here (not a row that bounces).
  const [staffRole, setStaffRole] = useState<MyRole | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMyRole()
      .then((role) => {
        if (!cancelled) setStaffRole(role);
      })
      .catch(() => {
        if (!cancelled) setStaffRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (!user) return null;

  const trimmed = query.trim();
  const matches = trimmed ? searchSettings(trimmed) : null;
  // Staff console entry. Moderators are staff, but every console destination
  // is admin-only, so offering them a row would be a tap that bounces back.
  // The row appears for an ADMIN only.
  const isStaff = staffRole?.role === "ADMIN";

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
    <SettingsPage title="Settings" className="fb-settings-root">
      <SettingsProfileHeader user={user} />
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
          <SettingsGroup title="Account">
            <SettingsRow
              title="Account & verification"
              icon={UserRound}
              iconTone="account"
              value={accountSummary(user)}
              route="/settings/account"
            />
          </SettingsGroup>
          <SettingsGroup title="Preferences">
            <SettingsRow
              title="Appearance"
              icon={Palette}
              iconTone="appearance"
              value={appearanceSummary(theme, settings.accent)}
              route="/settings/appearance"
            />
            <SettingsRow
              title="Notifications"
              icon={Bell}
              iconTone="notifications"
              value={notifValue ?? "Review settings"}
              route="/settings/notifications"
            />
            <SettingsRow
              title="Accessibility"
              icon={Accessibility}
              iconTone="accessibility"
              value={accessibilitySummary(settings.textScale, settings.reduceMotion)}
              route="/settings/accessibility"
            />
            <SettingsRow
              title="Feed layout"
              icon={LayoutGrid}
              iconTone="teal"
              value={feedLayoutSummary(feedLayout, resolveFeedLayout(feedLayout, viewportWidth))}
              route="/settings/feed-layout"
            />
          </SettingsGroup>
          <SettingsGroup title="Intelligence">
            <SettingsRow
              title="Local intelligence"
              description="Search and report tools that run on this phone."
              icon={Cpu}
              iconTone="ai"
              route="/settings/local-intelligence"
            />
            <SettingsRow
              title="AI & models"
              description="Cloud chat, and models that run on this phone."
              icon={Sparkles}
              iconTone="ai"
              route="/settings/ai"
            />
          </SettingsGroup>
          <SettingsGroup title="Privacy">
            <SettingsRow
              title="Privacy & safety"
              icon={ShieldCheck}
              iconTone="privacy"
              route="/settings/privacy"
            />
          </SettingsGroup>
          {isStaff && (
            <SettingsGroup title="Moderation">
              <SettingsRow
                title="Team & permissions"
                description="Who can moderate, and what each of them may do."
                icon={UserCog}
                iconTone="privacy"
                route="/settings/team"
              />
            </SettingsGroup>
          )}
          <SettingsGroup title="More">
            <SettingsNestedGroup
              title="Advanced"
              description="Uploads and troubleshooting."
              icon={SlidersHorizontal}
              iconTone="neutral"
            >
              <SettingsRow
                title="Media & uploads"
                icon={Image}
                iconTone="media"
                value={mediaSummary(settings.highQualityPhoto)}
                route="/settings/media"
              />
              <SettingsRow
                title="Diagnostics"
                icon={Activity}
                iconTone="privacy"
                route="/settings/diagnostics"
              />
            </SettingsNestedGroup>
            <SettingsNestedGroup
              title="Legal"
              description="Terms, privacy and rules."
              icon={Scale}
              iconTone="about"
            >
              <SettingsRow
                title="Terms of use"
                icon={Scale}
                iconTone="about"
                route="/settings/terms"
              />
              <SettingsRow
                title="Privacy policy"
                icon={ShieldCheck}
                iconTone="privacy"
                route="/settings/privacy-policy"
              />
              <SettingsRow
                title="Community guidelines"
                icon={Users}
                iconTone="help"
                route="/settings/community-guidelines"
              />
            </SettingsNestedGroup>
            <SettingsNestedGroup
              title="Help & about"
              description="Guides and app info."
              icon={LifeBuoy}
              iconTone="help"
            >
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
            </SettingsNestedGroup>
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
