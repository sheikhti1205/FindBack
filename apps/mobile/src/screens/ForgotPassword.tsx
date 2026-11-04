import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { EMAIL_PATTERN } from "../components/auth/authCopy";
import { requestPasswordReset } from "../services/auth";

/**
 * Password-reset request. Always shows the same inbox message whether or not
 * the address exists (anti-enumeration, same rule as sign-in). The email is
 * never cleared and no existence signal is rendered.
 */
export function ForgotPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    inFlight.current = true; setBusy(true);
    try {
      const address = email.trim();
      await requestPasswordReset(address);
      if (alive.current) navigate("/recovery", { state: { recoveryEmail: address } });
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "Email recovery is temporarily unavailable. Please try again.");
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    // V1-UI-002: this route renders outside Shell, so the main owns its own
    // viewport height + safe-area insets (exactly once — no other owner here).
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-8"
      style={{
        paddingTop: "max(2rem, env(safe-area-inset-top))",
        paddingBottom: "max(2rem, env(safe-area-inset-bottom))",
      }}
    >
      <h1 className="text-xl font-semibold">Reset your password</h1>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          {error && (
            <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
              {error}
            </p>
          )}
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
          <Button type="submit" size="lg" loading={busy}>
            Send recovery code
          </Button>
          <Link
            to="/signin"
            className="min-h-[44px] self-center px-2 py-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Back to sign in
          </Link>
        </form>
    </main>
  );
}
