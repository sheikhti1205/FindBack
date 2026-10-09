import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import type { PublicUser } from "@findback/shared";
import { normalizePhone, USERNAME_CHECK_DEBOUNCE_MS } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { AuthShell } from "../components/auth/AuthShell";
import { checkUsername } from "../services/auth";
// S2 (W0-B): READ-ONLY import of the now-landed real service as the seam
// default. Tests inject fakes through `__setCompleteSocialProfile`.
import {
  completeSocialProfile as stagedCompleteSocialProfile,
  type GoogleProfileSeed,
} from "../services/auth/googleSignIn";
import { getPendingReportRoute } from "../utils/pendingReportLink";

export type { GoogleProfileSeed };

/**
 * W0-C (S3) — social profile-completion screen (W0.5).
 *
 * Every Google-provided value is a SUGGESTION shown before profile creation:
 * name, username suggestion, avatar preview, and phone prefill are all
 * editable; nothing is silently forced. Email is read-only identity info.
 *
 * Frozen-contract notes (INTERFACES.md S2, W0-B owns the service):
 * - `completeSocialProfile` is consumed via a READ-ONLY import as the seam
 *   default (overridable in tests via `__setCompleteSocialProfile`).
 * - `suggestUsername` (S2) is likewise absent; `buildUsernameSuggestion` is
 *   the W0.6 local stopgap (name → email local-part, normalized to the
 *   existing username rules). The live `checkUsername` oracle is the REAL
 *   existing one (read-only import, same debounce pattern as SignUpForm).
 * - Google avatar allowlisting (Google hosts only) is enforced service-side
 *   by W0-B; the UI only previews the seed URL and offers Remove.
 */

export interface CompleteSocialProfileInput {
  username: string;
  displayName: string;
  /** E.164-normalized Bangladesh number. */
  phone: string;
  avatarUrl: string | null;
}

type CompleteSocialProfileFn = (
  input: CompleteSocialProfileInput,
) => Promise<PublicUser>;

/** Wired S2 default; tests override via `__setCompleteSocialProfile`. */
let completeSocialProfileImpl: CompleteSocialProfileFn | null =
  stagedCompleteSocialProfile;

/** Test hook: inject a fake completion service. */
export function __setCompleteSocialProfile(fn: CompleteSocialProfileFn): void {
  completeSocialProfileImpl = fn;
}

/** Restore the wired S2 default. */
export function __resetCompleteSocialProfile(): void {
  completeSocialProfileImpl = stagedCompleteSocialProfile;
}

/**
 * W0.6 local suggestion stopgap: normalize against the existing username
 * rules (^[A-Za-z0-9_]{3,20}$). Name first, then the email local-part.
 * Always returns a submittable shape; availability is decided by the live
 * `checkUsername` oracle, never by this function.
 */
export function buildUsernameSuggestion(name: string | null, email: string): string {
  const raw = (name?.trim() || email.split("@")[0] || "").toLowerCase();
  let cleaned = raw
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (!/^[a-z0-9_]{3,20}$/.test(cleaned)) {
    cleaned = `${cleaned}_user`.replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  }
  if (!/^[a-z0-9_]{3,20}$/.test(cleaned)) cleaned = "findback_user".slice(0, 20);
  return cleaned;
}

type UsernameState = "idle" | "loading" | "available" | "taken" | "invalid";

function initialsOf(displayName: string, email: string): string {
  const source = displayName.trim() || email;
  const letters = source.replace(/[^a-zA-Z]/g, "");
  return (letters.slice(0, 2) || "FB").toUpperCase();
}

export function CompleteProfile({
  seed,
  onCompleted,
}: {
  seed: GoogleProfileSeed;
  onCompleted?: (user: PublicUser) => void;
}) {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(seed.name ?? "");
  const [username, setUsername] = useState(
    seed.suggestedUsername || buildUsernameSuggestion(seed.name, seed.email),
  );
  const [phone, setPhone] = useState(seed.phone);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(seed.avatarUrl);
  const [usernameState, setUsernameState] = useState<UsernameState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkSeq = useRef(0);

  // Live, debounced username availability — same oracle + pattern as SignUpForm.
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (!name) {
      setError("Enter your name.");
      return;
    }
    const chosen = username.trim();
    if (!chosen) {
      setError("Enter a username.");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(chosen)) {
      setError("Username must be 3–20 letters, numbers or underscores.");
      return;
    }
    if (usernameState === "loading" || usernameState === "idle") {
      setError("Still checking username availability — wait a moment and try again.");
      return;
    }
    if (usernameState === "taken" || usernameState === "invalid") {
      setError("Please choose another username");
      return;
    }
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) {
      setError("Enter a valid Bangladesh mobile number (e.g., 01812345678).");
      return;
    }
    const complete = completeSocialProfileImpl;
    if (!complete) {
      setError("Couldn't save your profile right now. Please try again.");
      return;
    }
    setBusy(true);
    try {
      const user = await complete({
        username: chosen,
        displayName: name,
        phone: phoneNorm,
        avatarUrl,
      });
      onCompleted?.(user);
      navigate(getPendingReportRoute() ?? "/", { replace: true });
    } catch (err) {
      // Never surface raw internals (constraint names, status codes, or
      // backend-config details) — unconfigured backends fail closed.
      if (err instanceof Error && err.name === "SupabaseConfigError") {
        setError("Couldn't save your profile right now. Please try again.");
      } else {
        const message = err instanceof Error ? err.message : "";
        const leaked =
          /PGRST|23505|constraint|duplicate key/i.test(message) ? null : message || null;
        setError(leaked ?? "Couldn't save your profile. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Complete your profile"
      supporting="Review these suggestions from Google — change anything before continuing."
    >
      <div className="flex items-center gap-4">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt="Suggested profile photo"
            className="h-16 w-16 rounded-full border border-outline-variant object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container-low text-lg font-semibold text-on-surface"
          >
            {initialsOf(displayName, seed.email)}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm font-medium text-on-surface">{seed.email}</p>
          {avatarUrl && (
            <button
              type="button"
              onClick={() => setAvatarUrl(null)}
              className="flex min-h-[44px] items-center self-start px-2 text-sm font-medium text-on-surface underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Remove photo
            </button>
          )}
        </div>
      </div>

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {error && (
          <p
            className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
            role="alert"
          >
            {error}
          </p>
        )}

        <TextField
          label="Name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="name"
          placeholder="Your display name"
          required
        />

        <div>
          <TextField
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
            aria-describedby="complete-username-status"
            error={
              usernameState === "taken" || usernameState === "invalid"
                ? usernameState === "taken"
                  ? "Username is already taken"
                  : "3–20 letters, numbers or underscores"
                : undefined
            }
          />
          <p
            id="complete-username-status"
            className="mt-1 text-xs text-on-surface-variant"
            aria-live="polite"
          >
            {usernameState === "available" && "✓ Username available"}
            {usernameState === "taken" && "✗ Username already exists"}
            {usernameState === "invalid" && "3–20 letters, numbers or underscores"}
            {usernameState === "loading" && "Checking availability…"}
            {usernameState === "idle" && "Checked live while you type — no page reload."}
          </p>
        </div>

        <TextField
          label="Email"
          type="email"
          value={seed.email}
          readOnly
          aria-readonly="true"
          autoComplete="email"
          hint="Your Google account email — it can't be changed here."
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

        <Button type="submit" size="lg" loading={busy}>
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}

/**
 * Additive route wrapper. Seed arrives via router state (AuthGateway
 * `needsProfile` handoff) or via the auth-context `needsProfile` (W0-B boot
 * path: restart-while-incomplete); without either, back to `/auth` — never a
 * blank form, never a boot loop. Success syncs the user AND clears the
 * completion state so the guest guard stops redirecting here.
 */
export function CompleteProfileRoute() {
  const auth = useAuth();
  const location = useLocation();
  const stateSeed =
    (location.state as { seed?: GoogleProfileSeed } | null)?.seed ?? null;
  const seed = stateSeed ?? auth.needsProfile;
  if (!seed) return <Navigate to="/auth" replace />;
  return (
    <CompleteProfile
      seed={seed}
      onCompleted={(user) => {
        auth.setUser(user);
        auth.clearNeedsProfile();
      }}
    />
  );
}
