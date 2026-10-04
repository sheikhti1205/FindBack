import { Image } from "lucide-react";
import { useAppearance } from "../appearance";
import {
  PreferenceSwitchRow,
  SettingsGroup,
  SettingsPage,
} from "../components/settings";

/**
 * Settings → Media (`/settings/media`): photo upload quality. The switch owns
 * the real `highQualityPhoto` flag through `useAppearance()` — it applies
 * and persists the moment it is flipped, with no Save step and no fake tiers.
 */
export function MediaSettings() {
  const { settings, update } = useAppearance();

  return (
    <SettingsPage
      title="Media"
      description="How FindBack handles your photos. Changes apply right away."
      backTo="/settings"
    >
      <SettingsGroup
        title="Photo uploads"
        description="Photos are made smaller before upload so reports stay quick to open."
      >
        <PreferenceSwitchRow
          title="High quality photos"
          description={
            settings.highQualityPhoto
              ? "On. Photos keep extra detail and use more mobile data and storage."
              : "Off. Photos use less mobile data and storage."
          }
          icon={Image}
          iconTone="media"
          checked={settings.highQualityPhoto}
          onChange={(highQualityPhoto) => update({ highQualityPhoto })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
