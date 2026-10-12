import { Link } from "react-router";
import { motion } from "framer-motion";
import { motionDurations, pressFeedback } from "../uiMotion";
import type { AssistantModePreference } from "../../services/ai/aiPreferences";

export interface AssistantConfigureSheetProps {
  mode: AssistantModePreference;
  onSelectMode: (mode: AssistantModePreference) => void;
  /** Consumer model name for the conversational choice row (never an engine id). */
  modelTitle: string;
  onChooseModel: () => void;
}

const MODES: readonly {
  readonly value: AssistantModePreference;
  readonly title: string;
  readonly detail: string;
  readonly testId: string;
}[] = [
  {
    value: "automatic",
    title: "Automatic",
    detail: "Tries an installed on-device model first. Cloud fallback follows your current AI setting.",
    testId: "configure-mode-automatic",
  },
  {
    value: "on-device-only",
    title: "On-device only",
    detail: "Nothing is sent to a cloud AI provider.",
    testId: "configure-mode-on-device-only",
  },
  {
    value: "cloud-only",
    title: "Cloud only",
    detail: "Skips local generation and uses your connected cloud model.",
    testId: "configure-mode-cloud-only",
  },
];

/**
 * Assistant Configure sheet content (FBX-020): the conversational policy
 * choice (Automatic / On-device only / Cloud only), the conversational model
 * choice, and management links. Detail and performance claims appear only
 * when real (mode copy mirrors the privacy disclosure); there is no effort
 * or speed control because no such runtime control exists.
 */
export function AssistantConfigureSheet({
  mode,
  onSelectMode,
  modelTitle,
  onChooseModel,
}: AssistantConfigureSheetProps) {
  return (
    <div data-testid="assistant-configure" className="flex flex-col gap-4">
      <section aria-label="Assistant policy" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          How the assistant answers
        </h3>
        <div role="radiogroup" aria-label="Assistant policy" className="flex flex-col gap-2">
          {MODES.map((option) => {
            const selected = mode === option.value;
            return (
              <motion.button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={option.testId}
                onClick={() => onSelectMode(option.value)}
                whileTap={pressFeedback.button}
                transition={{ duration: motionDurations.instant }}
                className={`flex min-h-[48px] flex-col justify-center gap-0.5 rounded-m3-sm border px-3 text-left ${
                  selected ? "border-on-surface bg-surface-container-low" : "border-outline-variant"
                }`}
              >
                <span className="text-sm font-medium text-on-surface">
                  {selected ? "● " : "○ "}{option.title}
                </span>
                <span className="text-xs text-on-surface-variant">{option.detail}</span>
              </motion.button>
            );
          })}
        </div>
      </section>

      <section aria-label="Conversation model" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          Conversation model
        </h3>
        <motion.button
          type="button"
          data-testid="configure-choose-model"
          onClick={onChooseModel}
          whileTap={pressFeedback.button}
          transition={{ duration: motionDurations.instant }}
          className="flex min-h-[48px] items-center justify-between gap-2 rounded-m3-sm border border-outline-variant px-3 text-left"
        >
          <span className="truncate text-sm text-on-surface">{modelTitle}</span>
          <span className="shrink-0 text-xs font-medium text-on-surface-variant underline">Change</span>
        </motion.button>
      </section>

      <nav aria-label="Manage AI" className="flex flex-col gap-1">
        <Link
          to="/settings/ai/models"
          data-testid="configure-manage-models"
          className="flex min-h-[48px] items-center rounded-m3-sm px-3 text-sm font-medium text-on-surface hover:bg-surface-container"
        >
          Manage AI models
        </Link>
        <Link
          to="/settings/ai/connections"
          data-testid="configure-cloud-connections"
          className="flex min-h-[48px] items-center rounded-m3-sm px-3 text-sm font-medium text-on-surface hover:bg-surface-container"
        >
          Cloud connections
        </Link>
        <Link
          to="/settings/ai/advanced"
          data-testid="configure-advanced"
          className="flex min-h-[48px] items-center rounded-m3-sm px-3 text-sm font-medium text-on-surface hover:bg-surface-container"
        >
          Advanced
        </Link>
        <Link
          to="/settings/ai/privacy"
          data-testid="configure-privacy-details"
          className="flex min-h-[48px] items-center rounded-m3-sm px-3 text-sm font-medium text-on-surface hover:bg-surface-container"
        >
          Privacy details
        </Link>
      </nav>
    </div>
  );
}
