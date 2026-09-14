import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { motion } from "framer-motion";

export function SignIn() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 bg-surface px-5 py-10 text-on-surface"
    >
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">FindBack</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Sign in to report or recover lost items.
        </p>
      </header>

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
          required
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" size="lg" loading={busy}>
          Sign in
        </Button>
      </form>

      <p className="text-center text-sm text-on-surface-variant">
        New here?{" "}
        <Link to="/register" className="font-medium text-on-surface underline">
          Create an account
        </Link>
      </p>

      <div className="rounded-m3-md border border-outline-variant bg-surface-container-low p-3 text-xs text-on-surface-variant">
        Sign in with the email and password you registered. New accounts are
        confirmed with a real emailed code.
      </div>
    </motion.div>
  );
}
