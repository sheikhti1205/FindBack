/**
 * Onboarding page frames + illustrations (Task B, packet 05).
 *
 * Decorative only: every frame renders inside an `aria-hidden` container and
 * never carries information the copy does not already state. Page 3 never
 * renders a match probability (no percentages anywhere).
 *
 * Motion (packet 11): Framer Motion one-shot springs/staggers only — no
 * continuous particles, no waiting, no infinite decorative loops. Reduced
 * motion collapses every frame to a static arrangement plus fade (no
 * travel/parallax), selected via the caller's `reduced` flag.
 */

import { motion } from "framer-motion";
import {
  Backpack,
  Bell,
  Check,
  Contrast,
  FileText,
  ImagePlus,
  Key,
  Link2,
  Lock,
  MapPin,
  Moon,
  Search,
  Smartphone,
  Sun,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { ACCENT_OPTIONS } from "../../appearance";
import { motionDurations, motionEasings, motionSprings } from "../uiMotion";

export type OnboardingArtKind = "hero" | "report" | "match" | "setup";

const ACCENT_PREVIEW_IDS = ["emerald", "blue", "violet"] as const;

function accentSwatch(id: (typeof ACCENT_PREVIEW_IDS)[number]): string {
  return ACCENT_OPTIONS.find((a) => a.id === id)?.swatch ?? "#256c4a";
}

const settle = {
  hidden: (travel: { x?: number; y?: number }) => ({ opacity: 0, ...travel }),
  visible: { opacity: 1, x: 0, y: 0 },
} as const;

const fadeOnly = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
} as const;

function MiniCard({
  icon: Icon,
  label,
  reduced,
  travel,
  delay = 0,
}: {
  icon: LucideIcon;
  label: string;
  reduced: boolean;
  travel?: { x?: number; y?: number };
  delay?: number;
}) {
  return (
    <motion.span
      className="fb-ob-chip"
      variants={reduced ? fadeOnly : settle}
      custom={travel ?? { y: 10 }}
      transition={
        reduced
          ? { duration: motionDurations.fast, ease: motionEasings.inOut, delay }
          : { ...motionSprings.soft, delay }
      }
    >
      <Icon size={16} strokeWidth={2} aria-hidden />
      {label}
    </motion.span>
  );
}

function HeroArt({ reduced }: { reduced: boolean }) {
  return (
    <div className="fb-ob-hero">
      <motion.span
        className="fb-ob-mark"
        variants={reduced ? fadeOnly : settle}
        custom={{ scale: 0.9 }}
        transition={
          reduced
            ? { duration: motionDurations.fast, ease: motionEasings.inOut }
            : { ...motionSprings.soft }
        }
      >
        F
      </motion.span>
      <motion.span
        className="fb-ob-orbit"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: -6 }}
        transition={
          reduced
            ? { duration: motionDurations.fast, ease: motionEasings.inOut, delay: 0.05 }
            : { ...motionSprings.soft, delay: 0.05 }
        }
      >
        <MiniCard icon={Key} label="Keys" reduced={reduced} travel={{ x: -18, y: -10 }} delay={0.05} />
        <MiniCard
          icon={Smartphone}
          label="Phone"
          reduced={reduced}
          travel={{ x: 0, y: -22 }}
          delay={0.1}
        />
        <MiniCard
          icon={Backpack}
          label="Backpack"
          reduced={reduced}
          travel={{ x: 18, y: -10 }}
          delay={0.15}
        />
      </motion.span>
      <motion.span
        className="fb-ob-report-card"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 18 }}
        transition={
          reduced
            ? { duration: motionDurations.fast, ease: motionEasings.inOut, delay: 0.15 }
            : { ...motionSprings.soft, delay: 0.15 }
        }
      >
        <span className="fb-ob-report-icon">
          <Search size={16} strokeWidth={2} aria-hidden />
        </span>
        <span className="fb-ob-report-lines">
          <span className="fb-ob-line fb-ob-line--title" />
          <span className="fb-ob-line" />
        </span>
        <span className="fb-ob-report-pin">
          <MapPin size={16} strokeWidth={2} aria-hidden />
        </span>
      </motion.span>
    </div>
  );
}

function ReportArt({ reduced }: { reduced: boolean }) {
  const transition = reduced
    ? { duration: motionDurations.fast, ease: motionEasings.inOut }
    : motionSprings.soft;
  return (
    <div className="fb-ob-card-stack">
      <motion.span
        className="fb-ob-photo"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 12 }}
        transition={{ ...transition, delay: 0 }}
      >
        <ImagePlus size={22} strokeWidth={1.75} aria-hidden />
        <span className="fb-ob-photo-label">Photo</span>
      </motion.span>
      <motion.span
        className="fb-ob-title-row"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 10 }}
        transition={{ ...transition, delay: reduced ? 0.03 : 0.08 }}
      >
        <FileText size={16} strokeWidth={2} aria-hidden />
        <span className="fb-ob-line fb-ob-line--title" />
      </motion.span>
      <motion.span
        className="fb-ob-chip-row"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 8 }}
        transition={{ ...transition, delay: reduced ? 0.05 : 0.14 }}
      >
        <span className="fb-ob-chip">
          <Tag size={14} strokeWidth={2} aria-hidden />
          Category
        </span>
        <span className="fb-ob-chip">
          <MapPin size={14} strokeWidth={2} aria-hidden />
          Approximate area
        </span>
      </motion.span>
      <motion.span
        className="fb-ob-toggle"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 8 }}
        transition={{ ...transition, delay: reduced ? 0.07 : 0.2 }}
      >
        <span className="fb-ob-toggle-opt fb-ob-toggle-opt--active">Lost</span>
        <span className="fb-ob-toggle-opt">Found</span>
      </motion.span>
    </div>
  );
}

function MatchArt({ reduced }: { reduced: boolean }) {
  const arrive = (delay: number, travel: { x?: number; y?: number }) => ({
    variants: reduced ? fadeOnly : settle,
    custom: travel,
    transition: reduced
      ? { duration: motionDurations.fast, ease: motionEasings.inOut, delay }
      : { ...motionSprings.soft, delay },
  });
  return (
    <div className="fb-ob-match">
      <div className="fb-ob-match-cards">
        <motion.span className="fb-ob-match-card" {...arrive(0, { x: -24 })}>
          Lost
        </motion.span>
        <motion.span
          className="fb-ob-match-link"
          {...arrive(reduced ? 0.05 : 0.18, { y: 6 })}
        >
          <Link2 size={16} strokeWidth={2} aria-hidden />
        </motion.span>
        <motion.span className="fb-ob-match-card" {...arrive(0.05, { x: 24 })}>
          Found
        </motion.span>
      </div>
      <motion.span className="fb-ob-area" {...arrive(reduced ? 0.07 : 0.26, { y: 8 })}>
        <span className="fb-ob-area-dot" />
        <span className="fb-ob-area-ring" />
        <span className="fb-ob-area-label">Approximate area</span>
      </motion.span>
      {/* The lock never travels: privacy is fixed, in both motion modes. */}
      <span className="fb-ob-lock">
        <Lock size={16} strokeWidth={2} aria-hidden />
        Private details stay private
      </span>
    </div>
  );
}

function SetupArt({ reduced }: { reduced: boolean }) {
  const transition = reduced
    ? { duration: motionDurations.fast, ease: motionEasings.inOut }
    : motionSprings.soft;
  const themes = [
    { id: "light", label: "Light", icon: Sun, className: "fb-ob-theme--light" },
    { id: "dark", label: "Dark", icon: Moon, className: "fb-ob-theme--dark" },
    { id: "amoled", label: "True black", icon: Contrast, className: "fb-ob-theme--amoled" },
  ] as const;
  return (
    <div className="fb-ob-card-stack">
      <motion.span
        className="fb-ob-theme-row"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 10 }}
        transition={{ ...transition, delay: 0 }}
      >
        {themes.map((theme) => (
          <span key={theme.id} className={`fb-ob-theme ${theme.className}`}>
            <theme.icon size={16} strokeWidth={2} aria-hidden />
            {theme.label}
          </span>
        ))}
      </motion.span>
      <motion.span
        className="fb-ob-accent-row"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 8 }}
        transition={{ ...transition, delay: reduced ? 0.03 : 0.1 }}
      >
        {ACCENT_PREVIEW_IDS.map((id) => (
          <span
            key={id}
            className="fb-ob-accent-dot"
            style={{ backgroundColor: accentSwatch(id) }}
          />
        ))}
        <span className="fb-ob-accent-label">Emerald, Blue, Violet accents</span>
      </motion.span>
      <motion.span
        className="fb-ob-bell-row"
        variants={reduced ? fadeOnly : settle}
        custom={{ y: 8 }}
        transition={{ ...transition, delay: reduced ? 0.05 : 0.16 }}
      >
        <Bell size={16} strokeWidth={2} aria-hidden />
        Notifications
        <span className="fb-ob-switch fb-ob-switch--on">
          <Check size={14} strokeWidth={2.5} aria-hidden />
        </span>
      </motion.span>
    </div>
  );
}

/**
 * Decorative page frame for one onboarding page. Always `aria-hidden`;
 * `data-motion` exposes the static/full contract for tests and debugging.
 */
export function OnboardingArt({ kind, reduced }: { kind: OnboardingArtKind; reduced: boolean }) {
  return (
    <motion.div
      data-onboarding-art
      aria-hidden="true"
      data-motion={reduced ? "static" : "full"}
      className="fb-ob-art"
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: reduced ? 0 : 0.06 } } }}
    >
      {kind === "hero" && <HeroArt reduced={reduced} />}
      {kind === "report" && <ReportArt reduced={reduced} />}
      {kind === "match" && <MatchArt reduced={reduced} />}
      {kind === "setup" && <SetupArt reduced={reduced} />}
    </motion.div>
  );
}
