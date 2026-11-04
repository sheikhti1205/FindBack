import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { EMAIL_PATTERN, PASSWORD_RESET_SENT, RECOVERY_INVALID_LINK, RECOVERY_SUCCESS, RECOVERY_OTP_SUCCESS } from "../components/auth/authCopy";
import { createPasswordRecovery, exchangeRecoveryCode, requestPasswordReset, updatePassword, type PasswordRecovery } from "../services/auth";
import { OtpField } from "../components/auth/OtpField";
import { useOtpCountdown } from "../components/auth/useOtpCountdown";

/**
 * Recovery-link landing (`/recovery?code=…`, also reachable via App Links).
 * Public route: the link itself carries the credential, so no session is
 * required to open it. Flow: exchange code → set new password → signed in.
 * Invalid/expired/used links show the same invalid message (no enumeration).
 *
 * X4: when the external callback bridge already exchanged the code (the
 * browser `/recovery?code=…` path), it routes here with `state.recovered` and
 * the code never reaches the hash — phase starts at "ready".
 */
export function Recovery() {
  const location = useLocation();
  return <RecoveryFlow key={location.key} />;
}

function RecoveryFlow() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const bridgeState = (location.state ?? null) as
    | { recovered?: boolean; linkError?: boolean; recoveryEmail?: unknown }
    | null;
  const preExchanged = bridgeState?.recovered === true;
  const preFailed = bridgeState?.linkError === true;
  const email = typeof bridgeState?.recoveryEmail === "string" && EMAIL_PATTERN.test(bridgeState.recoveryEmail)
    ? bridgeState.recoveryEmail : "";
  const otpMode = Boolean(email) && !preExchanged && !preFailed && !params.get("code");
  const [phase, setPhase] = useState<"code" | "exchanging" | "ready" | "invalid" | "done">(
    otpMode ? "code" : preExchanged ? "ready" : preFailed ? "invalid" : "exchanging",
  );
  const [code, setCode] = useState("");
  const recovery = useRef<PasswordRecovery | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const { seconds, setSeconds } = useOtpCountdown(otpMode ? 30 : 0);
  const [message, setMessage] = useState(PASSWORD_RESET_SENT);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exchanged = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void recovery.current?.dispose().catch(() => undefined); recovery.current = null; };
  }, []);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;
    // The bridge already resolved the code (or declared the link invalid).
    if (otpMode || preExchanged || preFailed) return;
    const code = params.get("code") ?? "";
    exchangeRecoveryCode(code).then(
      () => { if (alive.current) setPhase("ready"); },
      () => { if (alive.current) setPhase("invalid"); },
    );
  }, [params, otpMode, preExchanged, preFailed]);

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || phase !== "code") return;
    if (!/^\d{6}$/.test(code)) { setError("Enter the six-digit recovery code from your email."); return; }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      recovery.current ??= createPasswordRecovery();
      await recovery.current.verify(email, code);
      if (alive.current) { setCode(""); setPhase("ready"); }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : "Could not verify the recovery code.");
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  async function resend() {
    if (inFlight.current || seconds > 0) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await requestPasswordReset(email);
      if (alive.current) {
        await recovery.current?.dispose(); recovery.current = null;
        setCode(""); setSeconds(30); setMessage(PASSWORD_RESET_SENT);
      }
    } catch (err) {
      if (alive.current) { setError(err instanceof Error ? err.message : "Email recovery is temporarily unavailable."); setSeconds(60); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || phase !== "ready") return;
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    inFlight.current = true; setBusy(true);
    try {
      if (otpMode) {
        const active = recovery.current!;
        await active.updatePassword(password);
        await active.dispose();
        if (recovery.current === active) recovery.current = null;
      }
      else await updatePassword(password);
      if (alive.current) { setPassword(""); setConfirm(""); setPhase("done"); }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : RECOVERY_INVALID_LINK);
    } finally {
      inFlight.current = false; if (alive.current) setBusy(false);
    }
  }

  return (
    // V1-UI-003: same viewport ownership as ForgotPassword — outside Shell,
    // so the main owns min viewport height + safe-area insets exactly once.
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-8"
      style={{
        paddingTop: "max(2rem, env(safe-area-inset-top))",
        paddingBottom: "max(2rem, env(safe-area-inset-bottom))",
      }}
    >
      <h1 className="text-xl font-semibold">{phase === "done" ? "Password updated" : phase === "code" ? "Check your email" : "Choose a new password"}</h1>
      {phase === "code" && (
        <form className="flex flex-col gap-4" onSubmit={verifyCode} noValidate>
          <p role="status" className="text-sm text-on-surface-variant">{message}</p>
          <p className="break-all text-sm font-medium">{email}</p>
          {error && <p role="alert" className="text-sm text-error">{error}</p>}
          <OtpField label="Recovery code" value={code} onChange={setCode} disabled={busy} />
          <Button type="submit" loading={busy}>Verify code</Button>
          <Button type="button" variant="outline" onClick={() => void resend()} disabled={busy || seconds > 0}>
            {seconds > 0 ? `Resend in ${seconds}s` : "Resend code"}
          </Button>
          <p className="text-sm text-on-surface-variant">If your email includes a reset link, you can use that instead.</p>
          <Link to="/forgot" className="min-h-11 py-3 text-sm underline">Use a different email</Link>
          <Link to="/signin" className="min-h-11 py-3 text-sm underline">Back to sign in</Link>
        </form>
      )}
      {phase === "exchanging" && (
        <p role="status" className="text-sm text-on-surface-variant">Checking your reset link…</p>
      )}
      {phase === "invalid" && (
        <>
          <p role="alert" className="text-sm text-error">{RECOVERY_INVALID_LINK}</p>
          <Link
            to="/forgot"
            className="min-h-[44px] self-start px-2 py-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Request a new code
          </Link>
        </>
      )}
      {phase === "ready" && (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          {error && (
            <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
              {error}
            </p>
          )}
          <TextField
            label="New password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            hint="At least 8 characters"
            required
          />
          <TextField
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required
          />
          <Button type="submit" size="lg" loading={busy}>
            Update password
          </Button>
          {otpMode && <Link to="/signin" className="min-h-11 py-3 text-sm underline">Back to sign in</Link>}
        </form>
      )}
      {phase === "done" && (
        <>
          <p role="status" className="text-sm text-on-surface-variant">{otpMode ? RECOVERY_OTP_SUCCESS : RECOVERY_SUCCESS}</p>
          <Button type="button" size="lg" onClick={() => navigate(otpMode ? "/signin" : "/", { replace: true })}>
            {otpMode ? "Sign in" : "Continue to Norfold"}
          </Button>
        </>
      )}
    </main>
  );
}
