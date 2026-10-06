import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageCircleQuestion, Search, PackageOpen, PackageSearch, Sparkles, ChevronDown } from "lucide-react";
import { motionDurations, motionEasings, pressFeedback } from "../uiMotion";

/** Guided flows a landing quick action may start — all reuse Help's router. */
export type LandingFlow = "lost" | "found" | "search";

export interface LandingQuickAction {
  flow: LandingFlow;
  label: string;
  /** Reuses the existing guided shortcut test ids so behavior stays asserted. */
  testId: string;
}

export interface AssistantLandingProps {
  username?: string | null;
  suggestions: readonly string[];
  quickActions: readonly LandingQuickAction[];
  /**
   * The exact consented privacy/AI truth shown elsewhere on the screen. It is
   * collapsed behind one tap here so it never dominates first paint, but it is
   * always reachable and never weakened.
   */
  privacyCopy: string;
  onSuggestion: (text: string) => void;
  onQuickAction: (flow: LandingFlow) => void;
}

const HOW_IT_WORKS: readonly { title: string; body: string }[] = [
  { title: "AI when available", body: "Uses your connected provider when the selected mode allows it." },
  { title: "Works without cloud", body: "Built-in help is available, and supported on-device models stay on this device." },
  { title: "Privacy controls", body: "You choose what is sent — each photo is picked per message, never automatically." },
];

/**
 * Consumer-facing empty Assistant landing (v0.9.0-beta.1). Presentational only:
 * every action is a callback into Help's existing controller, guided router and
 * composer. It replaces the old first-use text wall (synthetic greeting bubble +
 * scattered pills + a permanent privacy paragraph) without changing any AI,
 * guided-flow, history, model-picker or refusal behavior.
 */
export function AssistantLanding({
  username,
  suggestions,
  quickActions,
  privacyCopy,
  onSuggestion,
  onQuickAction,
}: AssistantLandingProps) {
  const [privacyOpen, setPrivacyOpen] = useState(false);
  return (
    <div
      data-testid="assistant-landing"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 py-4"
    >
      <section className="rounded-m3-lg border border-outline-variant bg-surface-container-low p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
          FindBack Assistant
        </p>
        <h2 className="mt-1 text-xl font-semibold leading-tight text-on-surface">
          Hi {username ?? "there"}!
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
          I can help with reporting, recovering, searching, verification and using FindBack.
        </p>
      </section>

      <section aria-labelledby="landing-popular" className="flex flex-col gap-2">
        <h3 id="landing-popular" className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          Popular questions
        </h3>
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          {suggestions.map((suggestion) => (
            <motion.button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              whileTap={pressFeedback.button}
              transition={{ duration: motionDurations.instant }}
              className="flex min-h-[48px] items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-3 text-left text-sm text-on-surface hover:bg-surface-container"
            >
              <MessageCircleQuestion size={16} aria-hidden className="shrink-0 text-on-surface-variant" />
              <span>{suggestion}</span>
            </motion.button>
          ))}
        </div>
      </section>

      <section aria-labelledby="landing-actions" className="flex flex-col gap-2">
        <h3 id="landing-actions" className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          Quick actions
        </h3>
        <div className="flex flex-col gap-2 min-[420px]:grid min-[420px]:grid-cols-3">
          {quickActions.map((action) => (
            <motion.button
              key={action.flow}
              type="button"
              data-testid={action.testId}
              onClick={() => onQuickAction(action.flow)}
              whileTap={pressFeedback.button}
              transition={{ duration: motionDurations.instant }}
              className="flex min-h-[48px] items-center justify-center gap-2 rounded-m3-md border border-outline bg-surface-container-low px-3 text-sm font-medium text-on-surface hover:bg-surface-container"
            >
              {action.flow === "lost" ? (
                <PackageSearch size={16} aria-hidden />
              ) : action.flow === "found" ? (
                <PackageOpen size={16} aria-hidden />
              ) : (
                <Search size={16} aria-hidden />
              )}
              {action.label}
            </motion.button>
          ))}
        </div>
      </section>

      <section aria-labelledby="landing-how" className="flex flex-col gap-2">
        <h3 id="landing-how" className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          How the assistant works
        </h3>
        <div className="rounded-m3-md border border-outline-variant bg-surface-container-low">
          {HOW_IT_WORKS.map((row, index) => (
            <div
              key={row.title}
              className={`flex gap-3 p-3 ${index > 0 ? "border-t border-outline-variant" : ""}`}
            >
              <Sparkles size={16} aria-hidden className="mt-0.5 shrink-0 text-on-surface-variant" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-on-surface">{row.title}</p>
                <p className="text-xs leading-relaxed text-on-surface-variant">{row.body}</p>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={privacyOpen}
          onClick={() => setPrivacyOpen((v) => !v)}
          className="flex min-h-[48px] items-center gap-1 self-start text-xs font-medium text-on-surface-variant underline"
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={`transition-transform ${privacyOpen ? "rotate-180" : ""}`}
          />
          Privacy &amp; AI details
        </button>
        <AnimatePresence initial={false}>
          {privacyOpen && (
            <motion.p
              key="landing-privacy-copy"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
              className="overflow-hidden text-xs leading-relaxed text-on-surface-variant"
            >
              {privacyCopy}
            </motion.p>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
