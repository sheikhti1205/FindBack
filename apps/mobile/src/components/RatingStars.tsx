import { useRef } from "react";
import { Star } from "lucide-react";

interface RatingStarsProps {
  /** The signed-in user's own rating (1–5), or null when unrated. */
  value: number | null;
  onRate: (star: number) => void;
  /** id of the visible "Your rating" label; preferred over ariaLabel. */
  labelId?: string;
  ariaLabel?: string;
}

const STARS = [1, 2, 3, 4, 5];

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

  function moveFocus(from: number, delta: 1 | -1) {
    const next = (from + delta + STARS.length) % STARS.length;
    refs.current[next]?.focus();
    onRate(STARS[next]!);
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
          moveFocus(index, 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(index, -1);
        } else if (e.key === "Home") {
          e.preventDefault();
          refs.current[0]?.focus();
          onRate(1);
        } else if (e.key === "End") {
          e.preventDefault();
          refs.current[STARS.length - 1]?.focus();
          onRate(5);
        }
      }}
    >
      {STARS.map((star, i) => (
        <button
          key={star}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={`${star} star${star > 1 ? "s" : ""}`}
          // Roving focus: one tab stop for the whole group.
          tabIndex={i === activeIndex ? 0 : -1}
          onClick={() => onRate(star)}
          className="flex min-h-[48px] min-w-[48px] items-center justify-center text-on-surface-variant hover:opacity-80"
        >
          <Star
            size={26}
            aria-hidden
            className={(value ?? 0) >= star ? "fill-on-surface text-on-surface" : ""}
          />
        </button>
      ))}
    </div>
  );
}
