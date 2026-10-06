import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { normalizePhone } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { motionDurations, motionEasings } from "../components/uiMotion";
import { motion } from "framer-motion";
import { sendPendingEmailCode, verifyPendingEmailCode, sendPhoneChangeCode, verifyPhoneChangeCode } from "../services/auth";
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
  const { user, refreshUser, setUser } = useAuth();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const { resendIn, setResendIn } = useResendCountdown();
  const { resendIn: verifyIn, setResendIn: setVerifyIn } = useResendCountdown();

  if (!user) return null;
  const verified = channel === "EMAIL" ? user.emailVerified : user.phoneVerified;
  const destination = channel === "EMAIL" ? user.email : normalizePhone(user.phone) ?? user.phone;

  async function onSend() {
    if (busy.current || resendIn > 0) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setMessage(null);
    try {
      if (channel === "PHONE") await sendPhoneChangeCode(user!.id, destination, sent);
      else await sendPendingEmailCode(user!.email);
      if (!alive.current) return;
      setSent(true);
      setCode("");
      setResendIn(channel === "PHONE" ? 60 : 30);
      setMessage(`Code sent to ${destination}.`);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "Could not send code");
      if (channel === "PHONE" && err instanceof Error && /too many attempts/i.test(err.message)) setResendIn(60);
    } finally {
      busy.current = false;
      if (alive.current) setSending(false);
    }
  }

  async function onVerify() {
    if (busy.current || verifyIn > 0 || (channel === "PHONE" && (!sent || !/^\d{6,10}$/.test(code.trim())))) return;
    busy.current = true;
    setVerifying(true);
    setError(null);
    try {
      if (channel === "PHONE") {
        const profile = await verifyPhoneChangeCode(user!.id, destination, code.trim());
        if (!alive.current) return;
        setUser(profile);
        setMessage("Phone verified.");
      } else {
        await verifyPendingEmailCode(user!.email, code.trim());
        if (!alive.current) return;
        await refreshUser();
      }
      if (!alive.current) return;
      setCode("");
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "Verification failed");
      if (channel === "PHONE" && err instanceof Error && /too many attempts/i.test(err.message)) {
        setVerifyIn(60);
        setResendIn(60);
      }
    } finally {
      busy.current = false;
      if (alive.current) setVerifying(false);
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
      className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-4"
    >
      <p className="text-sm text-on-surface-variant">
        {channel === "PHONE" && !sent ? "Send an SMS code to " : "Enter the code sent to "}<span className="font-medium text-on-surface">{destination}</span>.
      </p>
      {channel === "PHONE" && <Link to="/profile/edit" className="min-h-[44px] py-3 text-sm underline">Change mobile number</Link>}

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

      <OtpField label={channel === "PHONE" ? "Phone verification code" : "Verification code"} value={code} onChange={setCode} />

      <div className="flex flex-col gap-2">
        <Button onClick={onVerify} loading={verifying} disabled={sending || verifyIn > 0 || (channel === "PHONE" && (!sent || !/^\d{6,10}$/.test(code.trim())))} size="lg">
          {verifyIn > 0 ? `Verify again in ${verifyIn}s` : channel === "PHONE" ? "Verify phone" : "Verify email"}
        </Button>
        <Button variant="outline" size="lg" onClick={onSend} loading={sending} disabled={resendIn > 0 || verifying}>
          {resendIn > 0 ? `Resend in ${resendIn}s` : channel === "PHONE" ? (sent ? "Resend SMS code" : "Send SMS code") : "Send email code"}
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
      supporting="Confirm ownership of your email and mobile number with verification codes."
    >
      <div className="flex flex-col gap-3">
        <VerifyRow key={`${user!.id}:email:${user!.email}`} channel="EMAIL" />
        <VerifyRow key={`${user!.id}:phone:${normalizePhone(user!.phone) ?? user!.phone}`} channel="PHONE" />
      </div>
      <Button size="lg" onClick={() => navigate(getPendingReportRoute() ?? "/", { replace: true })}>
        Continue to app
      </Button>
    </AuthShell>
  );
}
