import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { RECOVERY_INVALID_LINK, RECOVERY_SUCCESS } from "../components/auth/authCopy";
import { exchangeRecoveryCode, updatePassword } from "../services/auth";

/**
 * Recovery-link landing (`/recovery?code=…`, also reachable via App Links).
 * Public route: the link itself carries the credential, so no session is
 * required to open it. Flow: exchange code → set new password → signed in.
 * Invalid/expired/used links show the same invalid message (no enumeration).
 */
export function Recovery() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"exchanging" | "ready" | "invalid" | "done">("exchanging");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;
    const code = params.get("code") ?? "";
    exchangeRecoveryCode(code).then(
      () => setPhase("ready"),
      () => setPhase("invalid"),
    );
  }, [params]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : RECOVERY_INVALID_LINK);
    } finally {
      setBusy(false);
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
      <h1 className="text-xl font-semibold">Choose a new password</h1>
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
            Request a new link
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
            hint="At least 8 characters"
            required
          />
          <TextField
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
          <Button type="submit" size="lg" loading={busy}>
            Update password
          </Button>
        </form>
      )}
      {phase === "done" && (
        <>
          <p role="status" className="text-sm text-on-surface-variant">{RECOVERY_SUCCESS}</p>
          <Button type="button" size="lg" onClick={() => navigate("/", { replace: true })}>
            Continue to FindBack
          </Button>
        </>
      )}
    </main>
  );
}
