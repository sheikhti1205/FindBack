import { useState } from "react";
import { Button } from "../Button";
// S1 (W0-A) + S2 (W0-B): READ-ONLY imports of the real modules. Availability
// now resolves a strategy: Android Credential Manager (native), browser OAuth
// (web), or unavailable (hidden). Tests inject fakes at the seam.
import {
  startGoogleSignIn,
  type GoogleIdTokenResult,
} from "../../native/googleAuth";
import {
  googleAuthStrategy,
  signInWithGoogleIdToken,
  signInWithGoogleWebOAuth,
  type GoogleAuthStrategy,
  type GoogleProfileSeed,
  type GoogleSignInOutcome,
} from "../../services/auth/googleSignIn";

export type { GoogleIdTokenResult, GoogleProfileSeed, GoogleSignInOutcome, GoogleAuthStrategy };

/**
 * W0-C (S3) — "Continue with Google" affordance, platform-strategy aware.
 *
 * Android: native Credential Manager → ID token + nonce → Supabase
 * `signInWithIdToken` (unchanged).
 * Web: Supabase `signInWithOAuth` redirect; the `/auth/callback` bridge
 * resolves the outcome after the provider returns.
 * Unavailable (no native bridge AND not a configured browser): the button is
 * not rendered at all (fail closed).
 */

export type GoogleAuthMode = "signin" | "signup";

export type GoogleAuthFailureKind =
  | "cancelled"
  | "unavailable"
  | "misconfigured"
  | "network"
  | "unknown";

export interface GoogleSignInSeams {
  strategy: () => GoogleAuthStrategy;
  startGoogleSignIn: (opts: { mode: GoogleAuthMode }) => Promise<GoogleIdTokenResult>;
  signInWithGoogleIdToken: (idToken: string, nonce: string) => Promise<GoogleSignInOutcome>;
  startWebOAuth: (opts?: { returnTo?: string | null }) => Promise<void>;
}

const WIRED_SEAMS: GoogleSignInSeams = {
  strategy: googleAuthStrategy,
  startGoogleSignIn,
  signInWithGoogleIdToken,
  startWebOAuth: signInWithGoogleWebOAuth,
};

let activeSeams: GoogleSignInSeams = WIRED_SEAMS;

/** Test hook: pass a partial to override the wired S1/S2/web defaults. */
export function __setGoogleSignInSeams(partial: Partial<GoogleSignInSeams>): void {
  activeSeams = { ...activeSeams, ...partial };
}

/** Restore the wired defaults (tests + safe teardown). */
export function __resetGoogleSignInSeams(): void {
  activeSeams = WIRED_SEAMS;
}

/** Availability probe for conditional rendering (button + divider stay paired). */
export function isGoogleSignInAvailable(): boolean {
  try {
    return activeSeams.strategy() !== "unavailable";
  } catch {
    return false;
  }
}

function failureKindOf(err: unknown): GoogleAuthFailureKind {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (
    kind === "cancelled" ||
    kind === "unavailable" ||
    kind === "misconfigured" ||
    kind === "network" ||
    kind === "unknown"
  ) {
    return kind;
  }
  return "unknown";
}

/**
 * Human-mapped errors. Returns null for user cancellation (silent — the user
 * dismissed the prompt, so no error is shown). NEVER surfaces raw provider
 * internals and NEVER includes the id token.
 */
function humanMessageFor(err: unknown): string | null {
  const kind = failureKindOf(err);
  if (kind === "cancelled") return null;
  if (kind === "misconfigured") {
    // Owner-side setup (console OAuth clients / provider enablement), never
    // device state: say so instead of blaming the device.
    return "Google sign-in isn't set up yet. Please try another sign-in method.";
  }
  if (kind === "unavailable") {
    return "Google sign-in isn't available right now.";
  }
  if (kind === "network") {
    return "Couldn't reach Google. Check your connection and try again.";
  }
  return "Google sign-in failed. Please try again.";
}

export function GoogleSignInButton({
  mode,
  onDone,
  returnTo,
}: {
  mode: GoogleAuthMode;
  onDone: (outcome: GoogleSignInOutcome) => void | Promise<void>;
  /** Web only: internal route to return to after the OAuth callback. */
  returnTo?: string | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let strategy: GoogleAuthStrategy = "unavailable";
  try {
    strategy = activeSeams.strategy();
  } catch {
    strategy = "unavailable";
  }

  // Fail closed: no strategy, no button. (Hooks above stay unconditional.)
  if (strategy === "unavailable") return null;

  async function onPress() {
    if (pending) return;
    setError(null);
    setPending(true);

    // Web: hand off to the browser OAuth redirect. The page navigates away and
    // the /auth/callback bridge finishes the flow; there is no in-page outcome.
    if (strategy === "web-oauth") {
      try {
        await activeSeams.startWebOAuth({ returnTo: returnTo ?? null });
        // Keep pending=true: the browser is leaving the page.
      } catch (err) {
        setError(humanMessageFor(err));
        setPending(false);
      }
      return;
    }

    // Android native: Credential Manager token → Supabase ID-token exchange.
    let outcome: GoogleSignInOutcome;
    try {
      // The id token AND raw nonce go straight to the service seam and are
      // never logged, printed, or embedded in any error/message. The nonce is
      // required: S2 is never called without one (no downgrade to
      // skip-nonce-check).
      const token = await activeSeams.startGoogleSignIn({ mode });
      if (!token.nonce) {
        throw Object.assign(
          new Error("Google sign-in failed. Please try again."),
          { kind: "unknown" as GoogleAuthFailureKind },
        );
      }
      outcome = await activeSeams.signInWithGoogleIdToken(token.idToken, token.nonce);
    } catch (err) {
      setError(humanMessageFor(err));
      setPending(false);
      return;
    }
    setPending(false);
    await onDone(outcome);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        loading={pending}
        onClick={onPress}
        className="w-full bg-surface"
      >
        <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center">
          <svg viewBox="0 0 24 24" className="h-5 w-5" focusable="false">
            <path
              fill="#4285F4"
              d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1z"
            />
            <path
              fill="#EA4335"
              d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77z"
            />
          </svg>
        </span>
        Continue with Google
      </Button>
      {error && (
        <p
          className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
