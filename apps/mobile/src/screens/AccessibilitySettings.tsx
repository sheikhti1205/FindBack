import { useId } from "react";
import { Check } from "lucide-react";
import {
  REDUCE_MOTION_OPTIONS,
  TEXT_SCALE_OPTIONS,
  useAppearance,
  type ReduceMotionOverride,
  type TextScaleId,
} from "../appearance";
import { SettingsGroup, SettingsPage } from "../components/settings";
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

interface RadioChoiceProps {
  name: string;
  value: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}

/** Native radio card reusing the foundation choice styling (incl. focus ring). */
function RadioChoice({ name, value, title, description, checked, onChange }: RadioChoiceProps) {
  const id = useId();
  return (
    <label className="fb-choice" data-checked={checked}>
      <input
        className="fb-choice-input"
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      />
      <span className="fb-choice-title" id={`${id}-label`}>
        {title}
        {checked && <Check size={16} aria-hidden="true" />}
      </span>
      <span className="fb-choice-description" id={`${id}-description`}>
        {description}
      </span>
    </label>
  );
}

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
        <fieldset className="fb-personal-fieldset">
          <legend className="sr-only">Text size</legend>
          <div className="fb-a11y-grid">
            {TEXT_SCALE_OPTIONS.map((option) => (
              <RadioChoice
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
        <fieldset className="fb-personal-fieldset">
          <legend className="sr-only">Motion</legend>
          <div className="fb-a11y-grid">
            {REDUCE_MOTION_OPTIONS.map((option) => (
              <RadioChoice
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
