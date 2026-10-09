import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth } from "../auth";
import { registerBackInterceptor } from "../components/backNavigation";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { motionDurations, motionEasings } from "../components/uiMotion";
import { getPendingReportRoute } from "../utils/pendingReportLink";
import { AuthShell } from "../components/auth/AuthShell";
import {
  GoogleSignInButton,
  isGoogleSignInAvailable,
  type GoogleSignInOutcome,
} from "../components/auth/GoogleSignInButton";
import { SignInForm } from "../components/auth/SignInForm";
import { SignUpForm } from "../components/auth/SignUpForm";
import { EMAIL_PATTERN, type AuthGatewayMode } from "../components/auth/authCopy";

export type { AuthGatewayMode };

export interface AuthGatewayProps {
  /**
   * Entry stage. The canonical `/auth` route uses `"email"`.
   * Compat: `/signin` uses `"signin"`, `/register` uses `"signup"`.
   */
  initialMode?: AuthGatewayMode;
  /** Prefilled address (e.g. carried from a shared-link flow). */
  initialEmail?: string;
}

type Stage = "email" | "signin" | "signup";

/**
 * Canonical progressive auth flow (`/auth`): email → sign in → explicit
 * sign-up. Privacy: the email stage performs syntax-only validation and NEVER
 * issues a remote "does this email exist?" lookup — sign-in vs sign-up is
 * decided by explicit user choice on stage B, never by a probe.
 *
 * Integrator contract: render `<AuthGateway />` at `/auth`,
 * `<AuthGateway initialMode="signin" />` at `/signin`, and
 * `<AuthGateway initialMode="signup" />` at `/register`. All three props
 * combinations keep working standalone.
 */
export function AuthGateway({ initialMode = "email", initialEmail = "" }: AuthGatewayProps) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>(initialMode);
  const [email, setEmail] = useState(initialEmail);
  // True once the address arrived via the email stage (chip mode). Compat
  // entries start unconfirmed so their form stays directly editable.
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Stage-aware Android back: walk gateway stages before system navigation.
  const stateRef = useRef({ stage, emailConfirmed });
  stateRef.current = { stage, emailConfirmed };
  useEffect(
    () =>
      registerBackInterceptor(() => {
        const cur = stateRef.current;
        if (cur.stage === "signup") {
          setStage("signin");
          return true;
        }
        if (cur.stage === "signin" && cur.emailConfirmed) {
          setStage("email");
          return true;
        }
        return false;
      }),
    [],
  );

  if (user) return <Navigate to={getPendingReportRoute() ?? "/"} replace />;

  /**
   * W0-C (S3) Google handoff. The button already ran the S1+S2 exchange:
   * an existing linked profile completes immediately (context synced, then
   * the pending destination), while a missing profile carries its seed to
   * `/complete-profile` via router state (auth-context `needsProfile` from
   * W0-B is read by the route wrapper once it lands).
   */
  async function handleGoogleDone(outcome: GoogleSignInOutcome) {
    if (outcome.status === "needsProfile") {
      navigate("/complete-profile", { state: { seed: outcome.seed } });
      return;
    }
    setUser(outcome.user);
    navigate(getPendingReportRoute() ?? "/", { replace: true });
  }

  function onEmailSubmit(e: FormEvent) {
    e.preventDefault();
    setEmailError(null);
    const address = email.trim();
    // Syntax ONLY — no remote lookup, no enumeration.
    if (!EMAIL_PATTERN.test(address)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmail(address);
    setEmailConfirmed(true);
    setStage("signin");
  }

  return (
    <AuthShell
      title={stage === "email" ? "Welcome to FindBack" : stage === "signin" ? "Sign in" : "Create your account"}
      supporting={
        stage === "email"
          ? "Sign in or create an account to report and recover lost items."
          : stage === "signin"
            ? "Welcome back — sign in to continue."
            : "Your contact details help reunite items with their owners."
      }
      illustration={stage === "email"}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={stage}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
        >
          {stage === "email" && (
            <div className="flex flex-col gap-4">
              {/* W0-C (S3) insertion ONLY: Google affordance + divider ABOVE the
                  email form. Mode "signup" is the superset entry point (full
                  account chooser + verified-phone request for new users);
                  returning users still resolve via the S2 outcome. Renders
                  nothing until the S1 bridge is configured (fail closed). */}
              {isGoogleSignInAvailable() && (
                <>
                  <GoogleSignInButton mode="signup" onDone={handleGoogleDone} />
                  <div
                    role="separator"
                    aria-label="or"
                    className="flex items-center gap-3 text-sm text-on-surface-variant"
                  >
                    <span aria-hidden="true" className="h-px flex-1 bg-outline-variant" />
                    <span>or</span>
                    <span aria-hidden="true" className="h-px flex-1 bg-outline-variant" />
                  </div>
                </>
              )}
              <form className="flex flex-col gap-4" onSubmit={onEmailSubmit} noValidate>
              {emailError && (
                <p
                  className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
                  role="alert"
                >
                  {emailError}
                </p>
              )}
              <motion.div
                layoutId="auth-email-chip"
                transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
              >
                <TextField
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  required
                />
              </motion.div>
              <Button type="submit" size="lg">
                Continue
              </Button>
              </form>
            </div>
          )}

          {stage === "signin" && (
            <SignInForm
              initialEmail={email}
              emailLocked={emailConfirmed}
              onRequestChangeEmail={() => setStage("email")}
              onSwitchToSignup={(next) => {
                if (next) setEmail(next);
                setStage("signup");
              }}
            />
          )}

          {stage === "signup" && (
            <SignUpForm initialEmail={email} onBackToSignin={() => setStage("signin")} />
          )}
        </motion.div>
      </AnimatePresence>
    </AuthShell>
  );
}
