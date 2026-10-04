import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Radar } from "lucide-react";
import { motionDurations, motionEasings } from "../uiMotion";

/**
 * Centered auth shell: brand mark, single h1 slot, and form content.
 * Safe-area padded; the column scrolls so the on-screen keyboard can never
 * permanently cover the active control.
 */
export function AuthShell({
  title,
  supporting,
  illustration,
  children,
}: {
  title: string;
  supporting?: string;
  illustration?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
      className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 overflow-y-auto bg-surface px-5 py-10 text-on-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <header className="flex flex-col gap-3">
        <span className="flex items-center gap-2.5" aria-hidden="true">
          <span className="flex h-11 w-11 items-center justify-center rounded-m3-md bg-primary text-on-primary">
            <Radar size={24} />
          </span>
          <span className="text-lg font-semibold tracking-tight">FindBack</span>
        </span>
        {illustration && (
          <span
            aria-hidden="true"
            className="flex items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant"
          >
            <Radar size={20} className="shrink-0 text-on-surface" />
            Lost something? FindBack helps it find its way back to you.
          </span>
        )}
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {supporting && <p className="text-sm text-on-surface-variant">{supporting}</p>}
      </header>
      {children}
    </motion.div>
  );
}
