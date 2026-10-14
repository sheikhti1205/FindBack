import { useEffect, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { listItemVariants, motionDurations, motionEasings, pressFeedback } from "./uiMotion";

/** Router link with shared press feedback (motion pass: always animated). */
const MotionLink = motion.create(Link);

interface PostCardProps {
  children: ReactNode;
  to: string;
  index?: number;
  /**
   * Home-feed redesign (W7B-HOME media-led): `home-feed` renders a chromeless
   * report block — no border, no surface fill, no rounding, no shadow. The
   * media spans the near-full block width while text/actions inset
   * separately inside the content; reports separate by whitespace + a thin
   * hairline, never nested container chrome. Unlike the default card it is
   * NOT a wrapping Link — the content block owns the detail link and the
   * action controls as siblings. Default keeps the pre-existing column card
   * verbatim.
   */
  variant?: "default" | "home-feed";
}

/**
 * P6: entrance animation is capped to the first visible cards. A long
 * paginated feed must not animate every card (one Motion per row, staggered
 * delays deep into the list). Motion policy: animations always play — no
 * reduced-motion gate here (see uiMotion); never nest a MotionConfig here.
 */
export const POST_CARD_ANIMATED_COUNT = 4;

/**
 * Wave A entrance suppression: the feed entrance plays once per session.
 * Realtime inserts, refetches, and full list remounts (e.g. error → content
 * swaps that remount every row) must NOT replay the rise-and-fade — only
 * the first mount animates. Effects flush after the whole batch renders,
 * so every card of the first mount still sees the flag unset.
 */
let feedEntrancePlayed = false;

/** Test-only reset for the entrance-suppression flag (fresh module per file). */
export function __resetFeedEntranceForTests(): void {
  feedEntrancePlayed = false;
}

export function PostCard({ children, to, index = 0, variant = "default" }: PostCardProps) {
  const animated = index < POST_CARD_ANIMATED_COUNT && !feedEntrancePlayed;
  useEffect(() => {
    if (animated) feedEntrancePlayed = true;
  }, [animated]);
  // UXN-2 / W2: the home-feed card is NOT one wrapping Link. A button nested
  // in a link is invalid DOM and breaks assistive tech, so the shell is a plain
  // div and PostCardContent owns navigation AND actions as siblings: the media
  // (own tap target), the detail Link (text), and the flat action row.
  // `to` is kept for API parity with PostList and still drives the default
  // variant; home-feed ignores it because PostCardContent links itself.
  const body =
    variant === "home-feed" ? (
      <div className="flex flex-col border-b border-outline-variant bg-transparent pb-5">
        {children}
      </div>
    ) : (
      <MotionLink
        to={to}
        whileTap={pressFeedback.button}
        transition={{ duration: motionDurations.instant }}
        className="flex flex-col gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low p-4 transition-colors hover:border-on-surface-variant active:bg-surface-container"
      >
        {children}
      </MotionLink>
    );
  if (!animated) {
    return (
      <article data-testid="post-card" data-animated="false">
        {body}
      </article>
    );
  }
  return (
    <motion.article
      data-testid="post-card"
      data-animated="true"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{
        duration: motionDurations.fast,
        ease: motionEasings.out,
        // Token-derived stagger: a fraction of the instant budget per row,
        // capped at one instant so deep rows never trail behind.
        delay: Math.min(index * motionDurations.instant * 0.3, motionDurations.instant),
      }}
    >
      {body}
    </motion.article>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-on-surface-variant">{icon}</div>}
      <h2 className="text-base font-semibold text-on-surface">{title}</h2>
      {subtitle && <p className="max-w-xs text-sm text-on-surface-variant">{subtitle}</p>}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-on-surface-variant" role="status">
      <span
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-outline border-t-on-surface"
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-outline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
      {status}
    </span>
  );
}
