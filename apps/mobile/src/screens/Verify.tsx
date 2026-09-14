import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { CheckCircle2, Mail, Phone } from "lucide-react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { sendVerificationCode, verifyCode } from "../services/auth";

type Channel = "EMAIL" | "PHONE";

function VerifyRow({ channel }: { channel: Channel }) {
  const { user, refreshUser } = useAuth();
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  if (!user) return null;
  const verified = channel === "EMAIL" ? user.emailVerified : user.phoneVerified;
  const destination = channel === "EMAIL" ? user.email : user.phone;

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function onSend() {
    setSending(true);
    setError(null);
    setMessage(null);
    setDemoCode(null);
    try {
      const res = await sendVerificationCode(channel);
      if (res.devCode) setDemoCode(res.devCode);
      setResendIn(res.resendAfterSeconds ?? 0);
      setMessage(`Code sent to ${destination}.`);
    } catch (err) {
      // e.g. phone verification is not enabled on the active provider.
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setSending(false);
    }
  }

  async function onVerify() {
    setVerifying(true);
    setError(null);
    try {
      await verifyCode(channel, code.trim());
      await refreshUser();
      setCode("");
      setDemoCode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  if (verified) {
    return (
      <div className="flex items-start gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4">
        <CheckCircle2 className="mt-0.5 shrink-0 text-on-surface" size={20} aria-hidden />
        <div>
          <p className="font-medium">
            {channel === "EMAIL" ? "Email" : "Phone"} verified
          </p>
          <p className="text-sm text-on-surface-variant">{destination}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-4">
      <div className="flex items-center gap-3">
        {channel === "EMAIL" ? (
          <Mail size={20} aria-hidden />
        ) : (
          <Phone size={20} aria-hidden />
        )}
        <div className="flex-1">
          <p className="font-medium">{channel === "EMAIL" ? "Verify email" : "Verify phone"}</p>
          <p className="text-sm text-on-surface-variant">{destination}</p>
        </div>
        <Button variant="outline" size="md" onClick={onSend} loading={sending} disabled={resendIn > 0}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : "Send code"}
        </Button>
      </div>

      {message && <p className="text-sm text-on-surface-variant">{message}</p>}
      {demoCode && (
        <p className="rounded-m3-xs bg-surface-container px-3 py-1.5 text-xs text-on-surface-variant">
          Demo mode — code shown by the dev server: <strong className="font-mono">{demoCode}</strong>
        </p>
      )}
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <TextField
          label="Verification code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))}
          inputMode="numeric"
          placeholder="00000000"
          className="flex-1"
        />
        <Button onClick={onVerify} loading={verifying} disabled={code.length < 6} className="mt-6">
          Verify
        </Button>
      </div>
    </div>
  );
}

/**
 * Pending-signup mode: the user has no session yet, so this uses the public
 * `/auth/email-verification/*` endpoints. On success the first Supabase session
 * is stored and the app is entered.
 */
function PendingEmailVerify({ email }: { email: string }) {
  const { verifyPendingEmail, resendPendingEmail } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(
    `We sent a verification code to your email.`,
  );
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function onResend() {
    setResending(true);
    setError(null);
    setMessage(null);
    try {
      await resendPendingEmail();
      setResendIn(30);
      setMessage("We sent a new verification code to your email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend code");
    } finally {
      setResending(false);
    }
  }

  async function onVerify() {
    setVerifying(true);
    setError(null);
    try {
      await verifyPendingEmail(code.trim());
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-5 bg-surface px-5 py-10 text-on-surface">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Confirm your email</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Enter the code sent to <span className="font-medium text-on-surface">{email}</span> to
          finish creating your account.
        </p>
      </header>

      <div className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-4">
        {message && <p className="text-sm text-on-surface-variant">{message}</p>}
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}

        <TextField
          label="Verification code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))}
          inputMode="numeric"
          placeholder="00000000"
        />

        <Button onClick={onVerify} loading={verifying} disabled={code.length < 6} size="lg">
          Verify and continue
        </Button>

        <Button
          variant="outline"
          onClick={onResend}
          loading={resending}
          disabled={resendIn > 0}
        >
          {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
        </Button>
      </div>
    </div>
  );
}

export function Verify() {
  const { user, pendingEmail, booting } = useAuth();
  const navigate = useNavigate();

  if (booting) return null;
  if (!user && !pendingEmail) return <Navigate to="/signin" replace />;
  if (!user && pendingEmail) return <PendingEmailVerify email={pendingEmail} />;

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-5 bg-surface px-5 py-10 text-on-surface">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Verify your contact details</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Confirm ownership of your email and phone, like a modern registration flow.
        </p>
      </header>
      <div className="flex flex-col gap-3">
        <VerifyRow channel="EMAIL" />
        <VerifyRow channel="PHONE" />
      </div>
      <Button onClick={() => navigate("/", { replace: true })}>Continue to app</Button>
    </div>
  );
}
