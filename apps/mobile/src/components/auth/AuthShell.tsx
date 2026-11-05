import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { BrandMark } from "../BrandMark";
import { PRODUCT_NAME } from "../../brand";
import { Link } from "react-router";
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
        <Link to="/" state={{ showPublic: true }} className="flex min-h-11 items-center gap-2.5 rounded-m3-xs focus-visible:outline-2 focus-visible:outline-primary">
          <BrandMark size={44} shape="tile" alt="" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </Link>
        <Link to="/" state={{ showPublic: true }} className="inline-flex min-h-11 items-center text-sm text-primary">Back to Norfold</Link>
        {illustration && (
          <span
            aria-hidden="true"
            className="flex items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant"
          >
            <BrandMark size={20} alt="" className="shrink-0" />
            Lost something? Norfold helps it find its way back to you.
          </span>
        )}
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {supporting && <p className="text-sm text-on-surface-variant">{supporting}</p>}
      </header>
      {children}
      <footer className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-on-surface-variant" aria-label="Legal">
        <Link to="/privacy" className="inline-flex min-h-11 items-center text-primary">Privacy</Link>
        <Link to="/terms" className="inline-flex min-h-11 items-center text-primary">Terms</Link>
        <Link to="/community-guidelines" className="inline-flex min-h-11 items-center text-primary">Community Guidelines</Link>
      </footer>
    </motion.div>
  );
}
