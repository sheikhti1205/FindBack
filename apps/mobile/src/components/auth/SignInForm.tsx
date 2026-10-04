import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { motion } from "framer-motion";
import { useAuth } from "../../auth";
import { Button } from "../Button";
import { TextField } from "../Fields";
import { motionDurations, motionEasings } from "../uiMotion";
import { getPendingReportRoute } from "../../utils/pendingReportLink";
import { EMAIL_PATTERN, SIGNIN_GENERIC_ERROR } from "./authCopy";

/**
 * Stage B sign-in form. Backend behavior is the pre-existing `login()` call —
 * only the presentation is new. Every sign-in failure (unknown email, wrong
 * password, offline) surfaces the SAME generic wording so nothing leaks
 * account membership. The email is never cleared on failure.
 *
 * No "Forgot password" link: no fully-implemented recovery exists in-repo,
 * so per the packet the action is omitted entirely rather than left dead.
 */
export function SignInForm({
  initialEmail,
  emailLocked,
  onRequestChangeEmail,
  onSwitchToSignup,
}: {
  initialEmail: string;
  /** True when the address arrived via the gateway email stage (chip shown). */
  emailLocked: boolean;
  /** "Change" next to the identity chip — returns to the email stage. */
  onRequestChangeEmail: () => void;
  /** "Create account with this email" — carries the current address. */
  onSwitchToSignup: (email: string) => void;
}) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [draftEmail, setDraftEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const address = (emailLocked ? initialEmail : draftEmail).trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    try {
      await login(address, password);
      navigate(getPendingReportRoute() ?? "/", { replace: true });
    } catch {
      // Deliberately generic: identical whether or not the email exists.
      // Never log the address or password alongside the failure.
      setError(SIGNIN_GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {emailLocked && (
        <motion.div
          layoutId="auth-email-chip"
          transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
          className="flex min-h-[44px] items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-3.5 py-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{initialEmail}</span>
          <button
            type="button"
            onClick={onRequestChangeEmail}
            className="flex min-h-[44px] min-w-[44px] items-center px-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Change
          </button>
        </motion.div>
      )}

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {error && (
          <p
            className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {!emailLocked && (
          <motion.div
            layoutId="auth-email-chip"
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
          >
            <TextField
              label="Email"
              type="email"
              value={draftEmail}
              onChange={(e) => setDraftEmail(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              required
            />
          </motion.div>
        )}
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <Button type="submit" size="lg" loading={busy}>
          Sign in
        </Button>
      </form>

      <Button
        variant="outline"
        size="lg"
        onClick={() => onSwitchToSignup((emailLocked ? initialEmail : draftEmail).trim())}
      >
        Create account with this email
      </Button>
    </div>
  );
}
