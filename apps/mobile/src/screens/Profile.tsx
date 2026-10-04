import { FileStack, Settings as SettingsIcon, ShieldQuestion } from "lucide-react";
import { useAuth } from "../auth";
import { ProfileHero } from "../components/ProfileHero";
import { SettingsGroup, SettingsPage, SettingsRow } from "../components/settings";

/**
 * Profile landing: identity hero plus My reports / Settings / Help.
 * Uses the shared settings page/group/row language (large title, grouped
 * card) so it reads as part of Settings, not a boxed utility screen.
 * Debug-panel content (appearance, AI links, self-test, about, logout,
 * phone hero) lives in Settings now.
 */
export function Profile() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <SettingsPage title="Profile">
      <ProfileHero user={user} />

      <nav aria-label="Profile actions">
        <SettingsGroup>
          <SettingsRow title="My reports" icon={FileStack} route="/my" />
          <SettingsRow title="Settings" icon={SettingsIcon} route="/settings" />
          <SettingsRow title="Help & guide" icon={ShieldQuestion} iconTone="sky" route="/settings/help" />
        </SettingsGroup>
      </nav>
    </SettingsPage>
  );
}
