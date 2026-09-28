import { useRef, type Ref } from "react";
import { Star } from "lucide-react";
import { motion, useAnimationControls } from "framer-motion";
import { motionDurations, motionEasings, motionSprings, pressFeedback } from "./uiMotion";

interface RatingStarsProps {
  /** The signed-in user's own rating (1–5), or null when unrated. */
  value: number | null;
  onRate: (star: number) => void;
  /** id of the visible "Your rating" label; preferred over ariaLabel. */
  labelId?: string;
  ariaLabel?: string;
}

const STARS = [1, 2, 3, 4, 5];

interface StarButtonProps {
  star: number;
  /** Whether this star is filled by the current (possibly optimistic) value. */
  filled: boolean;
  checked: boolean;
  tabIndex: number;
  label: string;
  buttonRef: Ref<HTMLButtonElement>;
  onRate: (star: number) => void;
}

/**
 * One star: a press-down squeeze (whileTap), an optimistic pop the moment its
 * fill arrives, and a quiet opacity crossfade for the fill itself — so a
 * rolled-back submit releases without a bounce. The base outline star never
 * moves; only the overlay and the pop wrapper animate.
 */
function StarButton({ star, filled, checked, tabIndex, label, buttonRef, onRate }: StarButtonProps) {
  // Imperative pop: fires on the tap itself (not on the value round-trip),
  // so the acknowledgement is immediate even before the parent updates.
  // start() interrupts any in-flight pop — rapid taps restart, never queue.
  const popControls = useAnimationControls();

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      // Roving focus: one tab stop for the whole group.
      tabIndex={tabIndex}
      onClick={() => {
        onRate(star);
        void popControls.start({ scale: [1.35, 1], transition: motionSprings.snappy });
      }}
      whileTap={pressFeedback.iconButton}
      className="flex min-h-[48px] min-w-[48px] items-center justify-center text-on-surface-variant hover:opacity-80"
    >
      <motion.span animate={popControls} data-star-pop className="relative inline-flex">
        <Star size={26} aria-hidden />
        <motion.span
          data-star-fill
          aria-hidden
          className="absolute inset-0 inline-flex items-center justify-center"
          initial={false}
          animate={{ opacity: filled ? 1 : 0, scale: filled ? 1 : 0.7 }}
          transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
        >
          <Star size={26} aria-hidden className="fill-on-surface text-on-surface" />
        </motion.span>
      </motion.span>
    </motion.button>
  );
}

/**
 * Accessible 1–5 star rating control.
 *
 * A radiogroup with a single roving tab stop: the selected star (or the first
 * when unrated) is tabbable, Arrow keys move within the group, and Home/End
 * jump to the ends. Community average is rendered separately by the caller so
 * the user's own stars are never filled from other people's ratings.
 */
export function RatingStars({ value, onRate, labelId, ariaLabel }: RatingStarsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = value != null ? value - 1 : 0;

  // Focus-only navigation: arrows/Home/End move the single tab stop without
  // rating. Activation (click / Enter / Space on the focused star) rates.
  function moveFocus(to: number) {
    const next = (to + STARS.length) % STARS.length;
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelId}
      className="flex"
      onKeyDown={(e) => {
        const index = refs.current.findIndex((el) => el === document.activeElement);
        if (index < 0) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(index + 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(index - 1);
        } else if (e.key === "Home") {
          e.preventDefault();
          moveFocus(0);
        } else if (e.key === "End") {
          e.preventDefault();
          moveFocus(STARS.length - 1);
        }
      }}
    >
      {STARS.map((star, i) => (
        <StarButton
          key={star}
          star={star}
          filled={(value ?? 0) >= star}
          checked={value === star}
          tabIndex={i === activeIndex ? 0 : -1}
          label={`${star} star${star > 1 ? "s" : ""}`}
          onRate={onRate}
          buttonRef={(el) => {
            refs.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
