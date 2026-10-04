/**
 * First-run onboarding (Task B, packet 05_ONBOARDING).
 *
 * Four pages with the exact packet copy, Skip/Back/Next/Get-started controls,
 * announced `N of 4` progress, and one-shot Framer Motion illustrations (see
 * `components/onboarding/OnboardingArt`). Reduced motion (the single
 * `useShouldReduceMotion` authority) collapses everything to a static
 * arrangement plus fade — no travel, no parallax, no drag paging.
 *
 * Persistence lives in `services/onboarding`: finishing via Skip OR Get
 * started stores version 2; mounting (including replay) never clears it. The
 * lead integrator owns the route/guard wiring — this component only persists
 * completion and reports it through `onComplete`.
 */

import { useCallback, useState } from "react";
import { motion, type PanInfo } from "framer-motion";
import { useShouldReduceMotion, motionDurations, motionEasings, motionSprings } from "../components/uiMotion";
import { OnboardingArt, type OnboardingArtKind } from "../components/onboarding/OnboardingArt";
import { completeOnboarding } from "../services/onboarding";
import "./Onboarding.css";

export interface OnboardingPage {
  title: string;
  body: string;
  art: OnboardingArtKind;
}

export const ONBOARDING_PAGES: readonly OnboardingPage[] = [
  {
    title: "Lose less. Find faster.",
    body: "Report a lost or found item and keep every update in one place.",
    art: "hero",
  },
  {
    title: "Report in seconds.",
    body: "Add a photo, details and an approximate area. You stay in control before anything is posted.",
    art: "report",
  },
  {
    title: "Useful matches. Privacy first.",
    body: "FindBack compares report details while keeping sensitive account information out of public browsing.",
    art: "match",
  },
  {
    title: "Set it up your way.",
    body: "Choose your theme, notifications and optional AI tools whenever you want.",
    art: "setup",
  },
] as const;

export interface OnboardingProps {
  /** Called after completion is persisted (host navigates away). */
  onComplete?: () => void;
  /** Zero-based starting page (testing / replay entry). Defaults to 0. */
  initialPage?: number;
}

function clampPage(page: number | undefined): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.trunc(page as number)), ONBOARDING_PAGES.length - 1);
}

export function Onboarding({ onComplete, initialPage = 0 }: OnboardingProps) {
  const reduced = useShouldReduceMotion();
  const [page, setPage] = useState(() => clampPage(initialPage));
  const last = page === ONBOARDING_PAGES.length - 1;
  const current = ONBOARDING_PAGES[page]!;

  const finish = useCallback(() => {
    completeOnboarding();
    onComplete?.();
  }, [onComplete]);

  const goNext = useCallback(() => {
    setPage((p) => Math.min(p + 1, ONBOARDING_PAGES.length - 1));
  }, []);

  const goBack = useCallback(() => {
    setPage((p) => Math.max(p - 1, 0));
  }, []);

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      if (reduced) return;
      if (info.offset.x < -60) goNext();
      else if (info.offset.x > 60) goBack();
    },
    [goBack, goNext, reduced],
  );

  return (
    <section
      aria-label="Onboarding"
      role="region"
      data-motion={reduced ? "static" : "full"}
      className="fb-onboarding"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") goNext();
        else if (event.key === "ArrowLeft") goBack();
      }}
    >
      <p
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuemin={1}
        aria-valuemax={ONBOARDING_PAGES.length}
        aria-valuenow={page + 1}
        className="fb-onboarding-progress"
      >
        {page + 1} of {ONBOARDING_PAGES.length}
      </p>

      <motion.div
        key="onboarding-pager"
        drag={reduced ? false : "x"}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.6}
        onDragEnd={handleDragEnd}
        className="fb-onboarding-pager"
      >
        <motion.div
          key={page}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
          transition={
            reduced
              ? { duration: motionDurations.fast, ease: motionEasings.inOut }
              : { ...motionSprings.soft }
          }
          className="fb-onboarding-page"
        >
          <OnboardingArt kind={current.art} reduced={reduced} />
          <h1 className="fb-onboarding-title">{current.title}</h1>
          <p className="fb-onboarding-body">{current.body}</p>
        </motion.div>
      </motion.div>

      <div className="fb-onboarding-controls">
        <div className="fb-onboarding-controls-row">
          {page > 0 ? (
            <button type="button" onClick={goBack} className="fb-onboarding-btn fb-onboarding-btn--ghost">
              Back
            </button>
          ) : (
            <span className="fb-onboarding-btn-spacer" aria-hidden="true" />
          )}
          {!last ? (
            <button type="button" onClick={goNext} className="fb-onboarding-btn fb-onboarding-btn--primary">
              Next
            </button>
          ) : (
            <button type="button" onClick={finish} className="fb-onboarding-btn fb-onboarding-btn--primary">
              Get started
            </button>
          )}
        </div>
        {!last && (
          <button type="button" onClick={finish} className="fb-onboarding-btn fb-onboarding-btn--quiet">
            Skip
          </button>
        )}
      </div>
    </section>
  );
}
