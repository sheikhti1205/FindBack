import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { motion } from "framer-motion";
import { useAuth } from "../../auth";
import { Button } from "../Button";
import { TextField } from "../Fields";
import { motionDurations, motionEasings } from "../uiMotion";
import { checkUsername } from "../../services/auth";
import { getPendingReportRoute } from "../../utils/pendingReportLink";
import { USERNAME_CHECK_DEBOUNCE_MS, normalizePhone } from "@findback/shared";

type UsernameState = "idle" | "loading" | "available" | "taken" | "invalid";

/**
 * Stage C signup form. Backend behavior is byte-for-byte the pre-existing
 * Register flow: live debounced username availability against the safe
 * boolean RPC, Bangladesh phone normalization, and the shared `register()`
 * call with its safe duplicate semantics. Only the presentation is new
 * (email prefilled from the user-chosen address, signup expansion motion).
 */
export function SignUpForm({
  initialEmail,
  onBackToSignin,
}: {
  initialEmail: string;
  onBackToSignin: () => void;
}) {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [usernameState, setUsernameState] = useState<UsernameState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkSeq = useRef(0);

  // Live, debounced username availability against the FindBack database.
  useEffect(() => {
    const raw = username.trim();
    const seq = ++checkSeq.current;
    if (raw.length === 0) {
      if (checkSeq.current === seq) setUsernameState("idle");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(raw)) {
      if (checkSeq.current === seq) setUsernameState("invalid");
      return;
    }
    if (checkSeq.current === seq) setUsernameState("loading");
    const timer = setTimeout(() => {
      checkUsername(raw)
        .then((res) => {
          if (checkSeq.current === seq) {
            setUsernameState(res.available ? "available" : "taken");
          }
        })
        .catch(() => {
          if (checkSeq.current === seq) setUsernameState("idle");
        });
    }, USERNAME_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [username]);

  const usernameMessage: Record<Exclude<UsernameState, "idle" | "loading">, string> = {
    available: "Username available",
    taken: "Username is already taken",
    invalid: "3–20 letters, numbers or underscores",
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = username.trim();
    if (!name) {
      setError("Enter a username.");
      return;
    }
    // Submit-time syntax validation (independent of live check)
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
      setError("Username must be 3–20 letters, numbers or underscores.");
      return;
    }
    // The live check must have actually answered before we let the account
    // through; "loading" and a network-errored "idle" both mean unknown.
    if (usernameState === "loading" || usernameState === "idle") {
      setError("Still checking username availability — wait a moment and try again.");
      return;
    }
    if (usernameState === "taken" || usernameState === "invalid") {
      setError("Please choose another username");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) {
      setError("Enter a valid Bangladesh mobile number (e.g., 01812345678).");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      // No credentials are logged here or anywhere downstream of this call.
      const outcome = await register({
        username: name,
        email: email.trim(),
        phone: phoneNorm,
        password,
      });
      if (outcome?.status === "pending") {
        navigate("/verify", { replace: true });
      } else {
        navigate(getPendingReportRoute() ?? "/", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
      className="overflow-hidden"
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {error && (
          <p
            className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
            role="alert"
          >
            {error}
          </p>
        )}

        <div>
          <TextField
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
            aria-describedby="username-status"
            error={
              usernameState === "taken" || usernameState === "invalid"
                ? usernameMessage[usernameState]
                : undefined
            }
          />
          <p
            id="username-status"
            className={`mt-1 text-xs ${
              usernameState === "available"
                ? "text-on-surface"
                : usernameState === "taken" || usernameState === "invalid"
                  ? "text-error"
                  : "text-on-surface-variant"
            }`}
            aria-live="polite"
          >
            {usernameState === "available" && "✓ Username available"}
            {usernameState === "taken" && "✗ Username already exists"}
            {usernameState === "invalid" && usernameMessage.invalid}
            {usernameState === "loading" && "Checking availability…"}
            {usernameState === "idle" && "Checked live while you type — no page reload."}
          </p>
        </div>

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
        <TextField
          label="Mobile (Bangladesh)"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="01812345678"
          inputMode="numeric"
          autoComplete="tel"
          required
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 8 characters"
          autoComplete="new-password"
          required
          data-testid="password-field"
        />
        <TextField
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        <Button type="submit" size="lg" loading={busy}>
          Create account
        </Button>
      </form>

      <button
        type="button"
        onClick={onBackToSignin}
        className="mt-4 flex min-h-[44px] w-full items-center justify-center px-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Back to sign in
      </button>
    </motion.div>
  );
}
