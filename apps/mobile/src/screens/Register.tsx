import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { motion } from "framer-motion";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { checkUsername } from "../services/auth";
import { USERNAME_CHECK_DEBOUNCE_MS } from "@findback/shared";

type UsernameState = "idle" | "loading" | "available" | "taken" | "invalid";

export function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [usernameState, setUsernameState] = useState<UsernameState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkSeq = useRef(0);

  if (user) return <Navigate to="/" replace />;

  // Live, debounced username availability against the FindBack database.
  useEffect(() => {
    const raw = username.trim();
    if (raw.length === 0) {
      setUsernameState("idle");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(raw)) {
      setUsernameState("invalid");
      return;
    }
    setUsernameState("loading");
    const seq = ++checkSeq.current;
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
    if (!phone.trim()) {
      setError("Enter a mobile number.");
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
      await register({ username: username.trim(), email: email.trim(), phone: phone.trim(), password });
      navigate("/verify", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-5 bg-surface px-5 py-10 text-on-surface"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Your contact details help reunite items with their owners.
        </p>
      </header>

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {error && (
          <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
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

      <p className="text-center text-sm text-on-surface-variant">
        Already have an account?{" "}
        <Link to="/signin" className="font-medium text-on-surface underline">
          Sign in
        </Link>
      </p>
    </motion.div>
  );
}
