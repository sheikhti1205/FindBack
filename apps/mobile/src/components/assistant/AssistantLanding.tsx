import { motion } from "framer-motion";
import { MessageCircleQuestion, PackageOpen, PackageSearch, Search, Sparkles } from "lucide-react";
import { motionDurations, pressFeedback } from "../uiMotion";

/** Guided flows a landing quick action may start — all reuse Help's router. */
export type LandingFlow = "lost" | "found" | "search";

export interface LandingQuickAction {
  flow: LandingFlow;
  label: string;
  /** Reuses the existing guided shortcut test ids so behavior stays asserted. */
  testId: string;
}

export interface AssistantLandingProps {
  suggestions: readonly string[];
  quickActions: readonly LandingQuickAction[];
  onSuggestion: (text: string) => void;
  onQuickAction: (flow: LandingFlow) => void;
}

/**
 * Conversation-first empty Assistant landing (U2). The transcript and composer
 * own the screen: a compact hero, at most three primary quick actions, and up
 * to four suggestion rows — then a flexible spacer so the composer stays
 * reachable without scrolling on ordinary phones. No product-information
 * sections, no privacy essay, no model internals: those live in the overflow
 * menu (Privacy & AI), the model picker, and the Help guide.
 */
export function AssistantLanding({
  suggestions,
  quickActions,
  onSuggestion,
  onQuickAction,
}: AssistantLandingProps) {
  return (
    <div
      data-testid="assistant-landing"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 py-6"
    >
      <section aria-label="Assistant greeting" className="flex flex-col items-center gap-1 pt-4 text-center">
        <Sparkles size={28} aria-hidden className="text-on-surface-variant" />
        <h2 className="mt-1 text-xl font-semibold leading-tight text-on-surface">
          What can I help with?
        </h2>
        <p className="text-sm leading-relaxed text-on-surface-variant">
          Report, search, or understand something you found.
        </p>
      </section>

      <section aria-label="Quick actions" className="flex flex-col items-center gap-2">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {quickActions.slice(0, 3).map((action) => (
            <motion.button
              key={action.flow}
              type="button"
              data-testid={action.testId}
              onClick={() => onQuickAction(action.flow)}
              whileTap={pressFeedback.button}
              transition={{ duration: motionDurations.instant }}
              className="flex min-h-[48px] items-center justify-center gap-2 rounded-full border border-outline bg-surface-container-low px-4 text-sm font-medium text-on-surface hover:bg-surface-container"
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

      <section aria-labelledby="landing-try" className="flex flex-col gap-2">
        <h3 id="landing-try" className="text-center text-xs font-medium text-on-surface-variant">
          Try asking
        </h3>
        <div className="flex flex-col gap-2">
          {suggestions.slice(0, 4).map((suggestion) => (
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

      <div aria-hidden className="min-h-2 flex-1" />
    </div>
  );
}
