import { SettingsGroup, SettingsPage } from "../components/settings";
import { NotificationSettings } from "../components/NotificationSettings";
import "./NotificationPreferences.css";

/**
 * Settings → Notifications. Thin wrapper: all semantics live in the shared
 * NotificationSettings component (same behavior as the inbox inline panel).
 */
export function NotificationPreferences() {
  return (
    <SettingsPage
      title="Notifications"
      backTo="/settings"
      description="Choose which report activity reaches this device. The in-app inbox keeps every notification either way."
    >
      <SettingsGroup title="Notification preferences">
        <div className="fb-notification-preferences">
          <NotificationSettings />
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
