import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { BrandMark } from "../BrandMark";
import { motionDurations, motionEasings } from "../uiMotion";
import "./AuthShell.css";

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
      className="fb-auth-shell mx-auto flex w-full max-w-md flex-col justify-center gap-6 bg-surface text-on-surface"
    >
      <header className="flex flex-col gap-3">
        <span className="flex items-center gap-2.5" aria-hidden="true">
          <BrandMark size={44} shape="tile" alt="" />
          <span className="text-lg font-semibold tracking-tight">FindBack</span>
        </span>
        {illustration && (
          <span
            aria-hidden="true"
            className="flex items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant"
          >
            <BrandMark size={20} alt="" className="shrink-0" />
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
