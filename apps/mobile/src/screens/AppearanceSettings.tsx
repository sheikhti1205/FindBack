import { ACCENT_OPTIONS, useAppearance } from "../appearance";
import { useTheme, type Theme } from "../theme";
import {
  AccentSwatch,
  PreferenceSwitchRow,
  SettingsGroup,
  SettingsPage,
  ThemeCard,
} from "../components/settings";
import "./AppearanceSettings.css";

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Settings → Appearance (`/settings/appearance`): theme + accent only, plus a
 * live preview. Everything applies and persists through `useTheme()` /
 * `useAppearance()` the moment it is picked — there is no Save step. The
 * true-black toggle is a modifier that only surfaces when the resolved mode can
 * be dark; picking Dark never forces true black on its own.
 */
export function AppearanceSettings() {
  const { theme, trueBlackDark, setTheme, setTrueBlackDark } = useTheme();
  const { settings, update } = useAppearance();
  const accentLabel =
    ACCENT_OPTIONS.find((option) => option.id === settings.accent)?.label ??
    ACCENT_OPTIONS[0]!.label;
  // Light can never resolve dark, so the modifier is irrelevant (and hidden).
  const trueBlackRelevant = theme !== "light";
  const previewLabel = trueBlackRelevant && trueBlackDark ? "True black" : THEME_LABELS[theme];

  return (
    <SettingsPage
      title="Appearance"
      description="Make FindBack look yours. Changes apply right away."
      backTo="/settings"
    >
      <SettingsGroup
        title="Theme"
        description="System follows your device. True black uses a pure black background."
      >
        <fieldset className="fb-personal-fieldset">
          <legend className="sr-only">Theme</legend>
          <div className="fb-theme-grid">
            {THEMES.map((value) => (
              <ThemeCard
                key={value}
                name="appearance-theme"
                value={value}
                checked={theme === value}
                onChange={setTheme}
              />
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      {trueBlackRelevant && (
        <SettingsGroup
          title="True black"
          description="Only used when dark mode is active."
        >
          <PreferenceSwitchRow
            title="True black in dark mode"
            description="Use a pure black background to save power on OLED screens."
            checked={trueBlackDark}
            onChange={setTrueBlackDark}
          />
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Accent"
        description="Used for buttons, links, and highlights across the app."
      >
        <fieldset className="fb-personal-fieldset">
          <legend className="sr-only">Accent</legend>
          <div className="fb-accent-grid">
            {ACCENT_OPTIONS.map((option) => (
              <AccentSwatch
                key={option.id}
                name="appearance-accent"
                accent={option.id}
                checked={settings.accent === option.id}
                onChange={(accent) => update({ accent })}
              />
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      <SettingsGroup
        title="Preview"
        description="A sample of your current look."
      >
        <div
          role="img"
          aria-label={`Preview of ${previewLabel} theme with ${accentLabel} accent`}
          data-theme={theme}
          data-true-black={trueBlackDark ? "true" : undefined}
          data-accent={settings.accent}
          className="fb-appearance-preview"
        >
          <span aria-hidden="true" className="fb-appearance-preview-row">
            <span className="fb-appearance-preview-button">Continue</span>
            <span className="fb-appearance-preview-chip">Found near you</span>
          </span>
          <span aria-hidden="true" className="fb-appearance-preview-row">
            <span className="fb-appearance-preview-link">View report details</span>
            <span className="fb-appearance-preview-focus">Focused field</span>
          </span>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
