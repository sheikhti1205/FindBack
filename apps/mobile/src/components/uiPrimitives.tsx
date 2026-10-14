/**
 * W-D shared UI primitives: stable skeletons, entrances, state swaps, and
 * compact empty/error treatments.
 *
 * Every animation uses the frozen `uiMotion` tokens (durations/easings/
 * variants) and transform/opacity only, so the root `<MotionConfig>`
 * degrades travel centrally under reduced motion. Skeleton shimmer is a
 * plain CSS pulse with `motion-reduce:animate-none`.
 *
 * Fixed block sizes are intentional: skeleton → content resolves without
 * reflow or flash (RailMate discipline, FindBack identity).
 */

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  fadeVariants,
  listItemVariants,
  motionDurations,
  motionEasings,
} from "./uiMotion";

const SHIMMER = "animate-pulse motion-reduce:animate-none bg-surface-container";
const LINE = "bg-surface-container";

/* ------------------------------------------------------------------ */
/* Skeleton block                                                      */
/* ------------------------------------------------------------------ */

export function Skeleton({
  label,
  width,
  height,
  className = "",
  rounded = "rounded-m3-xs",
}: {
  /** Accessible name announced once while content loads. */
  label?: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  rounded?: string;
}) {
  const style: Record<string, string> = {};
  if (width !== undefined) style.width = typeof width === "number" ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === "number" ? `${height}px` : height;
  const block = (
    <span
      aria-hidden={label ? undefined : true}
      data-testid="skeleton-block"
      style={style}
      className={`${SHIMMER} block ${rounded} ${className}`}
    />
  );
  if (!label) return block;
  return (
    <span role="status" aria-label={label} className="block">
      {block}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Feed skeleton (density-aware, fixed sizes — no layout jump)         */
/* ------------------------------------------------------------------ */

export function FeedSkeleton({
  density = "home-feed",
  count = 3,
  label = "Loading posts",
}: {
  density?: "home-feed" | "compact" | "classic" | "editorial";
  count?: number;
  label?: string;
}) {
  const cards = Array.from({ length: count }, (_, i) => i);
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 px-4">
      {cards.map((i) => (
        <div
          key={i}
          data-testid="feed-skeleton-card"
          aria-hidden="true"
          className="flex flex-col border-b border-outline-variant pb-5"
        >
          {density === "compact" ? (
            <div className="flex gap-3">
              <span data-testid="feed-skeleton-media" className={`${SHIMMER} h-20 w-20 shrink-0 rounded-m3-sm`} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
                <span className={`${LINE} ${SHIMMER} h-4 w-3/4 rounded-m3-xs`} />
                <span className={`${LINE} ${SHIMMER} h-3 w-1/2 rounded-m3-xs`} />
                <span className={`${LINE} ${SHIMMER} h-3 w-2/3 rounded-m3-xs`} />
              </div>
            </div>
          ) : (
            <>
              <span
                data-testid="feed-skeleton-media"
                className={`${SHIMMER} w-full rounded-m3-md`}
                style={{ aspectRatio: "4 / 3" }}
              />
              <div className="flex flex-col gap-2 px-1 pt-3">
                <span className={`${LINE} ${SHIMMER} h-4 w-2/3 rounded-m3-xs`} />
                <span className={`${LINE} ${SHIMMER} h-3 w-full rounded-m3-xs`} />
                <span className={`${LINE} ${SHIMMER} h-3 w-5/6 rounded-m3-xs`} />
                <div className="flex gap-2 pt-1">
                  <span className={`${LINE} ${SHIMMER} h-8 w-20 rounded-full`} />
                  <span className={`${LINE} ${SHIMMER} h-8 w-20 rounded-full`} />
                </div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inbox / detail / comment skeletons                                  */
/* ------------------------------------------------------------------ */

export function InboxSkeleton({ count = 4, label = "Loading notifications" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 py-4">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          data-testid="inbox-skeleton-row"
          aria-hidden="true"
          className="flex items-center gap-3 rounded-m3-md border border-outline-variant p-3"
        >
          <span className={`${SHIMMER} h-8 w-8 shrink-0 rounded-full`} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className={`${LINE} ${SHIMMER} h-3.5 w-3/4 rounded-m3-xs`} />
            <span className={`${LINE} ${SHIMMER} h-3 w-1/2 rounded-m3-xs`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton({ label = "Loading report" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4 px-4 py-5">
      <div data-testid="detail-skeleton" aria-hidden="true" className="flex flex-col gap-3">
        <span className={`${SHIMMER} w-full rounded-m3-md`} style={{ aspectRatio: "4 / 3" }} />
        <span className={`${LINE} ${SHIMMER} h-6 w-2/3 rounded-m3-xs`} />
        <div className="flex items-center gap-2">
          <span className={`${SHIMMER} h-8 w-8 rounded-full`} />
          <span className={`${LINE} ${SHIMMER} h-3 w-32 rounded-m3-xs`} />
        </div>
        <span className={`${LINE} ${SHIMMER} h-3 w-full rounded-m3-xs`} />
        <span className={`${LINE} ${SHIMMER} h-3 w-5/6 rounded-m3-xs`} />
        <div className="flex gap-2 pt-1">
          <span className={`${LINE} ${SHIMMER} h-9 w-24 rounded-full`} />
          <span className={`${LINE} ${SHIMMER} h-9 w-24 rounded-full`} />
        </div>
      </div>
    </div>
  );
}

export function CommentSkeleton({ count = 3, label = "Loading comments" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-testid="comment-skeleton-row" aria-hidden="true" className="flex gap-2.5">
          <span className={`${SHIMMER} h-7 w-7 shrink-0 rounded-full`} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={`${LINE} ${SHIMMER} h-3 w-1/3 rounded-m3-xs`} />
            <span className={`${LINE} ${SHIMMER} h-3.5 w-full rounded-m3-xs`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EnterReveal: small opacity/translation entrance, first-reveal stagger */
/* ------------------------------------------------------------------ */

let revealPlayed = false;

/** Test-only reset for the first-reveal suppression flag. */
export function __resetRevealForTests(): void {
  revealPlayed = false;
}

export function EnterReveal({
  index = 0,
  children,
  className = "",
}: {
  /** Position in a short list; stagger is capped so deep rows never trail. */
  index?: number;
  children: ReactNode;
  className?: string;
}) {
  const firstReveal = !revealPlayed;
  if (firstReveal) revealPlayed = true;
  if (!firstReveal) return <div className={className}>{children}</div>;
  return (
    <motion.div
      data-testid="enter-reveal"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      transition={{
        duration: motionDurations.fast,
        ease: motionEasings.out,
        delay: Math.min(index * 0.03, motionDurations.instant),
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* StateSwap: animated loading→content / error→retry / empty→content    */
/* ------------------------------------------------------------------ */

export function StateSwap({
  stateKey,
  children,
}: {
  stateKey: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={stateKey}
        data-testid="state-swap"
        variants={fadeVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={{ duration: motionDurations.fast, ease: motionEasings.inOut }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Compact empty / error treatments                                    */
/* ------------------------------------------------------------------ */

export function EmptyView({
  icon,
  title,
  subtitle,
  action,
  titleId = "empty-view-title",
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  titleId?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-on-surface-variant">{icon}</div>}
      <h2 id={titleId} className="text-base font-semibold text-on-surface">
        {title}
      </h2>
      {subtitle && <p className="max-w-xs text-sm text-on-surface-variant">{subtitle}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function ErrorView({
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p role="alert" className="max-w-xs text-sm text-on-surface-variant">
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-5 text-sm font-medium text-on-surface"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
