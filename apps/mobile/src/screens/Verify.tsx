import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { CheckCircle2, Phone } from "lucide-react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { motionDurations, motionEasings } from "../components/uiMotion";
import { motion } from "framer-motion";
import { sendPendingEmailCode, verifyPendingEmailCode } from "../services/auth";
import { getPendingReportRoute } from "../utils/pendingReportLink";
import { AuthShell } from "../components/auth/AuthShell";
import { OtpField } from "../components/auth/OtpField";

type Channel = "EMAIL" | "PHONE";

function useResendCountdown() {
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  return { resendIn, setResendIn } as const;
}

function VerifyRow({ channel }: { channel: Channel }) {
  const { user, refreshUser } = useAuth();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { resendIn, setResendIn } = useResendCountdown();

  if (!user) return null;
  const verified = channel === "EMAIL" ? user.emailVerified : user.phoneVerified;
  const destination = channel === "EMAIL" ? user.email : user.phone;

  async function onSend() {
    setSending(true);
    setError(null);
    setMessage(null);
    try {
      await sendPendingEmailCode(user!.email);
      setResendIn(30);
      setMessage(`Code sent to ${destination}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setSending(false);
    }
  }

  async function onVerify() {
    setVerifying(true);
    setError(null);
    try {
      await verifyPendingEmailCode(user!.email, code.trim());
      await refreshUser();
      setCode("");
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
          <p className="font-medium">{channel === "EMAIL" ? "Email" : "Phone"} verified</p>
          <p className="text-sm text-on-surface-variant">{destination}</p>
        </div>
      </div>
    );
  }

  // Phone verification is deferred (no SMS provider configured): show the stored
  // number truthfully as unverified rather than calling an unavailable service.
  if (channel === "PHONE") {
    return (
      <div className="flex items-start gap-3 rounded-m3-md border border-outline-variant p-4">
        <Phone className="mt-0.5 shrink-0 text-on-surface-variant" size={20} aria-hidden />
        <div>
          <p className="font-medium">Phone · unverified</p>
          <p className="text-sm text-on-surface-variant">{destination}</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            Your number is saved. Verification for phone numbers isn&apos;t available yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
      className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-4"
    >
      <p className="text-sm text-on-surface-variant">
        Enter the code sent to <span className="font-medium text-on-surface">{destination}</span>.
      </p>

      {message && (
        <p className="text-sm text-on-surface-variant" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}

      <OtpField value={code} onChange={setCode} />

      <div className="flex flex-col gap-2">
        <Button onClick={onVerify} loading={verifying} size="lg">
          Verify
        </Button>
        <Button variant="outline" size="lg" onClick={onSend} loading={sending} disabled={resendIn > 0}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : "Send code"}
        </Button>
      </div>
    </motion.div>
  );
}

/**
 * Pending-signup mode: the user has no session yet, so this uses the public
 * `/auth/email-verification/*` endpoints. On success the first Supabase session
 * is stored and the pending destination (usually the shared report) is entered.
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
  const { resendIn, setResendIn } = useResendCountdown();

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
      navigate(getPendingReportRoute() ?? "/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <AuthShell
      title="Check your email"
      supporting="Enter the code we sent to finish creating your account."
    >
      <p className="rounded-m3-md border border-outline-variant bg-surface-container-low px-4 py-3 text-sm">
        <span className="font-medium text-on-surface">{email}</span>
      </p>

      <div className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-4">
        {message && (
          <p className="text-sm text-on-surface-variant" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}

        <OtpField value={code} onChange={setCode} />

        <Button onClick={onVerify} loading={verifying} size="lg">
          Verify and continue
        </Button>

        <Button variant="outline" size="lg" onClick={onResend} loading={resending} disabled={resendIn > 0}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
        </Button>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex min-h-[44px] min-w-[44px] items-center px-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Back
          </button>
          <Link
            to="/auth"
            className="flex min-h-[44px] items-center px-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Use a different email
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

export function Verify() {
  const { user, pendingEmail, booting } = useAuth();
  const navigate = useNavigate();

  if (booting) return null;
  if (!user && !pendingEmail) return <Navigate to="/signin" replace />;
  if (!user && pendingEmail) return <PendingEmailVerify email={pendingEmail} />;

  return (
    <AuthShell
      title="Verify your contact details"
      supporting="Confirm ownership of your email with the code we sent."
    >
      <div className="flex flex-col gap-3">
        <VerifyRow channel="EMAIL" />
        <VerifyRow channel="PHONE" />
      </div>
      <Button size="lg" onClick={() => navigate(getPendingReportRoute() ?? "/", { replace: true })}>
        Continue to app
      </Button>
    </AuthShell>
  );
}
