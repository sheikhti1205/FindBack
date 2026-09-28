import { AnimatePresence, motion } from "framer-motion";
import {
  motionDurations,
  motionEasings,
} from "./uiMotion";

interface NewPostsPillProps {
  count: number;
  hasUpdates?: boolean;
  onTap: () => void;
}

/**
 * "N new posts" pill shown when the reader is scrolled down and new posts
 * arrived via realtime. Updates (edits/reactions) show an Updates label
 * instead of incrementing the new-post count. Tapping refreshes and
 * scrolls to top; scroll is never yanked.
 *
 * Motion: the pill drops in from above with a small shared fade/translate
 * and leaves cleanly after tap (AnimatePresence exit). The motion node keeps
 * a stable key so count updates only swap the label text and never replay
 * the whole entrance. No frozen from-above variant exists in uiMotion
 * (reported Wave-D gap), so the travel uses a small inline y with the
 * shared standard duration/easing — transform/opacity only.
 */
export function NewPostsPill({ count, hasUpdates, onTap }: NewPostsPillProps) {
  const visible = count > 0 || hasUpdates === true;
  const label = count > 0 ? `${count} new post${count === 1 ? "" : "s"}` : "Updates";
  return (
    <div className="sticky top-2 z-10 flex min-h-[48px] justify-center px-4" aria-live="polite">
      <AnimatePresence initial={false}>
        {visible && (
          <motion.button
            key="new-posts-pill"
            type="button"
            onClick={onTap}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            className="min-h-[48px] rounded-full bg-on-surface px-4 py-2 text-sm font-medium text-surface shadow-lg"
            aria-label={`${label} — tap to refresh`}
          >
            {label}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
