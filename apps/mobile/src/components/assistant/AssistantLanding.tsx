import { motion } from "framer-motion";
import { MessageCircleQuestion, Sparkles } from "lucide-react";
import { motionDurations, pressFeedback } from "../uiMotion";

export interface AssistantLandingProps {
  suggestions: readonly string[];
  onSuggestion: (text: string) => void;
  /**
   * Keyboard-collapsed mode (FBX-020): the on-screen keyboard owns the
   * viewport, so the greeting shrinks and the suggestion list hides,
   * keeping the composer reachable without scrolling.
   */
  compact?: boolean;
}

/**
 * Conversation-first empty Assistant landing (U2). The transcript and composer
 * own the screen: a compact greeting and up to four suggestion rows,
 * then a flexible spacer so the composer stays
 * reachable without scrolling on ordinary phones. No product-information
 * sections, no privacy essay, no model internals: those live in the overflow
 * menu (Privacy & AI), the model picker, and the Help guide.
 */
export function AssistantLanding({
  suggestions,
  onSuggestion,
  compact = false,
}: AssistantLandingProps) {
  return (
    <div
      data-testid="assistant-landing"
      data-compact={compact ? "true" : undefined}
      className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface px-4 ${compact ? "py-2" : "py-6"}`}
    >
      <section aria-label="Assistant greeting" className={`flex flex-col items-center gap-1 text-center ${compact ? "" : "pt-4"}`}>
        <Sparkles size={compact ? 20 : 28} aria-hidden className="text-on-surface-variant" />
        <h2 className="mt-1 text-xl font-semibold leading-tight text-on-surface">
          What can I help with?
        </h2>
        {!compact && (
          <p className="text-sm leading-relaxed text-on-surface-variant">
            Ask a question or talk something through.
          </p>
        )}
      </section>

      {!compact && (
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
      )}

      <div aria-hidden className="min-h-2 flex-1" />
    </div>
  );
}
