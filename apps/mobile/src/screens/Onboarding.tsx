/** User-paced editorial onboarding; persistence and routing keep their owners. */
import { forwardRef, useCallback, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, type PanInfo } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { useShouldReduceMotion, motionDurations, motionEasings, motionSprings } from "../components/uiMotion";
import { completeOnboarding } from "../services/onboarding";
import "./Onboarding.css";

export interface OnboardingPage {
  primary: string;
  secondary: string;
  body: string;
  detail: string;
}

export const ONBOARDING_PAGES: readonly OnboardingPage[] = [
  {
    primary: "Lost", secondary: "something?",
    body: "Create a report with real photos, useful details and one place for people to respond.",
    detail: "Choose an approximate area. Review the details before you post.",
  },
  {
    primary: "Found", secondary: "something?",
    body: "Post what you found without turning the handoff into a guessing game.",
    detail: "Keep enough identifying detail private so the right person can prove it is theirs.",
  },
  {
    primary: "Search reports.", secondary: "Follow likely matches.",
    body: "Photos, category, date and area help narrow things down without random scrolling.",
    detail: "A match suggestion is a starting point, not a guarantee.",
  },
  {
    primary: "You stay", secondary: "in control.",
    body: "Message requests, blocking and location choices stay in your hands.",
    detail: "Confirm the details and agree a safe handover before marking an item recovered.",
  },
] as const;

export interface OnboardingProps {
  /** Called after canonical completion is persisted; the host owns navigation. */
  onComplete?: () => void;
  initialPage?: number;
}

function clampPage(page: number | undefined): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.trunc(page as number)), ONBOARDING_PAGES.length - 1);
}

const Scene = forwardRef<HTMLDivElement, { page: number; reduced: boolean; direction: number }>(function Scene({ page, reduced, direction }, ref) {
  const present = useIsPresent();
  const current = ONBOARDING_PAGES[page]!;
  const transition = { duration: reduced ? motionDurations.fast : motionDurations.emphasized, ease: motionEasings.out };
  return (
    <motion.div
      ref={ref}
      className="fb-onboarding-page"
      data-scene={page}
      aria-hidden={!present || undefined}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: motionDurations.fast }}
    >
      <h1 className="fb-onboarding-title">
        <span className="fb-onboarding-mask"><motion.span
          initial={reduced ? false : { y: `${direction * 100}%` }} animate={{ y: 0 }}
          exit={reduced ? undefined : { y: `${direction * -25}%` }} transition={transition}
        >{current.primary}</motion.span></span>{" "}
        <span className="fb-onboarding-mask fb-onboarding-secondary"><motion.span
          initial={reduced ? false : { y: `${direction * 100}%` }} animate={{ y: 0 }}
          exit={reduced ? undefined : { y: `${direction * -25}%` }}
          transition={{ ...transition, delay: reduced ? 0 : .04 }}
        >{current.secondary}</motion.span></span>
      </h1>
      <motion.div className="fb-onboarding-copy"
        initial={reduced ? false : { y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
        transition={{ ...transition, delay: reduced ? 0 : .06 }}
      >
        <p className="fb-onboarding-body">{current.body}</p>
        <p className="fb-onboarding-detail">{current.detail}</p>
      </motion.div>
    </motion.div>
  );
});

export function Onboarding({ onComplete, initialPage = 0 }: OnboardingProps) {
  const reduced = useShouldReduceMotion();
  const [{ page, direction }, setPosition] = useState(() => ({ page: clampPage(initialPage), direction: 1 }));
  const finished = useRef(false);
  const last = page === ONBOARDING_PAGES.length - 1;
  const current = ONBOARDING_PAGES[page]!;
  const move = useCallback((delta: number) => {
    setPosition(p => {
      const next = clampPage(p.page + delta);
      return next === p.page ? p : { page: next, direction: delta };
    });
  }, []);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    completeOnboarding();
    onComplete?.();
  }, [onComplete]);
  const handleDragEnd = useCallback((event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (reduced || event.type === "pointercancel" || Math.abs(info.offset.x) <= Math.abs(info.offset.y)) return;
    if (info.offset.x < -60) move(1);
    else if (info.offset.x > 60) move(-1);
  }, [move, reduced]);

  return (
    <section aria-label="Onboarding" role="region" tabIndex={0}
      data-motion={reduced ? "static" : "full"} className="fb-onboarding"
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
        if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
        if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
        else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault(); if (last) finish(); else move(1);
        }
      }}
    >
      <header className="fb-onboarding-header">
        <div className="fb-onboarding-brand"><BrandMark size={28} shape="tile" alt="" /><span>Norfold</span></div>
        {!last && <button type="button" onClick={finish} className="fb-onboarding-btn fb-onboarding-btn--quiet">Skip</button>}
      </header>

      <div className="fb-onboarding-pager">
        <p className="fb-onboarding-index" aria-hidden="true">0{page + 1} / 04</p>
        <motion.div className="fb-onboarding-drag"
          drag={reduced ? false : "x"} dragConstraints={{ left: 0, right: 0 }}
          dragElastic={.35} dragMomentum={false} dragSnapToOrigin
          onDragEnd={handleDragEnd} transition={motionSprings.soft}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <Scene key={page} page={page} direction={direction} reduced={reduced} />
          </AnimatePresence>
        </motion.div>
      </div>

      <footer className="fb-onboarding-controls">
        <div role="progressbar" aria-label="Onboarding progress" aria-valuemin={1}
          aria-valuemax={4} aria-valuenow={page + 1} aria-valuetext={`${page + 1} of 4`}
          className="fb-onboarding-progress">
          <span className="sr-only">{page + 1} of 4</span>
          {ONBOARDING_PAGES.map((_, i) => <span key={i} className="fb-onboarding-segment" aria-hidden="true" data-filled={i <= page} />)}
        </div>
        <p role="status" aria-atomic="true" className="sr-only">{page + 1} of 4. {current.primary} {current.secondary}</p>
        <div className="fb-onboarding-controls-row">
          {page > 0 ? <button type="button" onClick={() => move(-1)} className="fb-onboarding-btn fb-onboarding-btn--quiet">Back</button>
            : <span className="fb-onboarding-btn-spacer" aria-hidden="true" />}
          <button type="button" onClick={last ? finish : () => move(1)} className="fb-onboarding-btn fb-onboarding-btn--primary">
            {last ? "Get started" : "Next"}<ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </section>
  );
}
