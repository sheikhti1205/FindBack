import { Link } from "react-router";
import { FileStack, Settings as SettingsIcon, ShieldQuestion } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "../auth";
import { ProfileHero } from "../components/ProfileHero";
import { pressFeedback } from "../components/uiMotion";

/** Nav rows with a tiny press state; navigation itself is untouched. */
const MotionLink = motion.create(Link);

/**
 * Profile landing: identity hero plus My reports / Settings / Help.
 * Debug-panel content (appearance, AI links, self-test, about, logout,
 * phone hero) lives in Settings now.
 */
export function Profile() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
      </header>

      <ProfileHero user={user} />

      <nav className="flex flex-col gap-2" aria-label="Profile actions">
        <MotionLink
          to="/my"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <FileStack size={18} aria-hidden />
          My reports
        </MotionLink>
        <MotionLink
          to="/settings"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <SettingsIcon size={18} aria-hidden />
          Settings
        </MotionLink>
        <MotionLink
          to="/settings/help"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <ShieldQuestion size={18} aria-hidden />
          Help &amp; guide
        </MotionLink>
      </nav>
    </div>
  );
}
