import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { motionDurations, snackbarVariants } from "./uiMotion";

const EVENT = "findback:announce";

/** Visible toast lifetime before it auto-exits (the announcement persists). */
export const SNACKBAR_AUTO_EXIT_MS = 3000;

/** Announce a meaningful event to screen readers (and any visible toast host). */
export function announce(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

/**
 * The one animated snackbar primitive: rise/fade enter, auto-exit, shared by
 * the LiveRegion toast and the back-handler exit toast. Transform/opacity
 * only. With `live` (default) it IS the polite live status; LiveRegion sets
 * `live={false}` because its sr-only region already announces (no doubles).
 */
export function Snackbar({
  open,
  message,
  live = true,
}: {
  open: boolean;
  message: string;
  live?: boolean;
}) {
  return (
    <AnimatePresence>
      {open && message !== "" && (
        <motion.div
          key="fb-snackbar"
          role={live ? "status" : undefined}
          aria-hidden={live ? undefined : true}
          initial="hidden"
          animate="visible"
          exit="hidden"
          variants={snackbarVariants}
          transition={{ duration: motionDurations.fast }}
          className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
        >
          <span
            data-testid="snackbar-message"
            className="rounded-full bg-on-surface px-4 py-2 text-sm text-surface shadow-lg"
          >
            {message}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Polite live region. Mount once (in Shell) — screens announce via `announce()`. */
export function LiveRegion({ autoExitMs = SNACKBAR_AUTO_EXIT_MS }: { autoExitMs?: number }) {
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail ?? "";
      setMessage(text);
      setVisible(text !== "");
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), autoExitMs);
    return () => window.clearTimeout(timer);
  }, [visible, message, autoExitMs]);

  return (
    <>
      <div
        aria-live="polite"
        role="status"
        data-testid="live-region-announcement"
        className="sr-only"
      >
        {message}
      </div>
      <Snackbar open={visible} message={message} live={false} />
    </>
  );
}
