import { Link } from "react-router";
import { useState } from "react";
import { CheckCircle2, LogOut, ShieldQuestion, FileStack, KeyRound, Info } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { MonitoringSelfTest } from "../components/MonitoringSelfTest";
import { Segmented } from "../components/Segmented";
import { pressFeedback } from "../components/uiMotion";
import { useTheme, type Theme } from "../theme";

/** Nav rows with a tiny press state; navigation itself is untouched. */
const MotionLink = motion.create(Link);

export function Profile() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [loggingOut, setLoggingOut] = useState(false);
  if (!user) return null;

  const VerifyLink = ({ done, label }: { done: boolean; label: string }) => (
    <span className="flex items-center gap-1.5 text-xs">
      {done ? (
        <>
          <CheckCircle2 size={14} aria-hidden className="text-on-surface" />
          <span className="text-on-surface-variant">{label} verified</span>
        </>
      ) : label === "Phone" ? (
        // Phone verification is not implemented in this build; do not send
        // the user to a dead end.
        <span className="text-on-surface-variant">Phone verification unavailable in this build</span>
      ) : (
        <Link to="/verify" className="font-medium text-on-surface underline">
          Verify {label.toLowerCase()}
        </Link>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-6 px-4 py-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
      </header>

      <section className="flex flex-col gap-1 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
        <p className="text-lg font-semibold">@{user.username}</p>
        <p className="text-sm text-on-surface-variant">{user.email}</p>
        <p className="text-sm text-on-surface-variant">{user.phone}</p>
        <div className="mt-2 flex flex-wrap gap-4">
          <VerifyLink done={user.emailVerified} label="Email" />
          <VerifyLink done={user.phoneVerified} label="Phone" />
        </div>
      </section>

      <nav className="flex flex-col gap-2" aria-label="Profile links">
        <MotionLink
          to="/my"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <FileStack size={18} aria-hidden />
          My reports
        </MotionLink>
        <MotionLink
          to="/help"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <ShieldQuestion size={18} aria-hidden />
          Help &amp; FAQ
        </MotionLink>
        <MotionLink
          to="/ai-connection"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <KeyRound size={18} aria-hidden />
          AI Connection
        </MotionLink>
        <MotionLink
          to="/about"
          whileTap={pressFeedback.button}
          className="flex min-h-[48px] items-center gap-3 rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          <Info size={18} aria-hidden />
          About
        </MotionLink>
      </nav>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">Appearance</p>
        <Segmented<Theme>
          ariaLabel="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </section>

      <MonitoringSelfTest />

      <Button
        variant="outline"
        loading={loggingOut}
        onClick={() => {
          if (loggingOut) return;
          setLoggingOut(true);
          void logout().finally(() => setLoggingOut(false));
        }}
      >
        <LogOut size={16} aria-hidden />
        Log out
      </Button>
    </div>
  );
}
