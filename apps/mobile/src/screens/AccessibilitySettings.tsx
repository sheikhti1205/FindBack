import {
  REDUCE_MOTION_OPTIONS,
  TEXT_SCALE_OPTIONS,
  useAppearance,
  type ReduceMotionOverride,
  type TextScaleId,
} from "../appearance";
import { PreferenceRadioRow, SettingsGroup, SettingsPage } from "../components/settings";
import "./AccessibilitySettings.css";

const TEXT_DESCRIPTIONS: Record<TextScaleId, string> = {
  compact: "Smaller text so more fits on screen.",
  standard: "A comfortable size for most people.",
  large: "Easier to read at a glance.",
  xlarge: "Largest text. Every screen stays usable.",
};

const MOTION_LABELS: Record<ReduceMotionOverride, string> = {
  system: "Follow system",
  reduce: "Reduce",
  full: "Full",
};

const MOTION_DESCRIPTIONS: Record<ReduceMotionOverride, string> = {
  system: "Match the motion setting on your device.",
  reduce: "Calm transitions with no extra movement.",
  full: "Play every animation.",
};

/**
 * Settings → Accessibility (`/settings/accessibility`): the canonical text
 * size and motion controls, plus a sample preview. Everything applies and
 * persists through `useAppearance()` the moment it is picked — no Save step.
 */
export function AccessibilitySettings() {
  const { settings, update } = useAppearance();
  const textLabel =
    TEXT_SCALE_OPTIONS.find((option) => option.id === settings.textScale)?.label ??
    "Default";
  const motionLabel = MOTION_LABELS[settings.reduceMotion];

  return (
    <SettingsPage
      title="Accessibility"
      description="Reading and motion comforts. Changes apply right away."
      backTo="/settings"
    >
      <SettingsGroup
        title="Text size"
        description="Scales text across the whole app."
      >
        <fieldset className="fb-choice-fieldset">
          <legend className="sr-only">Text size</legend>
          <div className="fb-choice-list">
            {TEXT_SCALE_OPTIONS.map((option) => (
              <PreferenceRadioRow
                key={option.id}
                name="accessibility-text-size"
                value={option.id}
                title={option.label}
                description={TEXT_DESCRIPTIONS[option.id]}
                checked={settings.textScale === option.id}
                onChange={() => update({ textScale: option.id })}
              />
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      <SettingsGroup
        title="Motion"
        description="Control animation and movement on screen."
      >
        <fieldset className="fb-choice-fieldset">
          <legend className="sr-only">Motion</legend>
          <div className="fb-choice-list">
            {REDUCE_MOTION_OPTIONS.map((option) => (
              <PreferenceRadioRow
                key={option.value}
                name="accessibility-motion"
                value={option.value}
                title={MOTION_LABELS[option.value]}
                description={MOTION_DESCRIPTIONS[option.value]}
                checked={settings.reduceMotion === option.value}
                onChange={() => update({ reduceMotion: option.value })}
              />
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      <SettingsGroup title="Preview" description="A sample of your current comfort settings.">
        <div
          role="region"
          aria-label="Sample preview"
          data-text-scale={settings.textScale}
          data-motion={settings.reduceMotion}
          className="fb-a11y-preview"
        >
          <p className="fb-a11y-preview-status">
            Text size: {textLabel} · Motion: {motionLabel}
          </p>
          <div className="fb-a11y-sample">
            <p className="fb-a11y-sample-title">Milo — lost near Green Park</p>
            <p className="fb-a11y-sample-body">
              Golden retriever, friendly and wearing a blue collar. Last seen
              near the north gate this morning.
            </p>
            <span aria-hidden="true" className="fb-a11y-motion-demo" />
          </div>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
