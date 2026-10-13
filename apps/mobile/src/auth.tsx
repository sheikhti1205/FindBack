import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PublicUser } from "@findback/shared";
import {
  BootTimeoutError,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  restoreSession,
  sendPendingEmailCode,
  verifyPendingEmailCode,
} from "./services/auth";
import {
  beginAccountSwitch,
  clearAllAuth,
  getPendingEmail,
  onSignedOut,
  setPendingEmail as persistPendingEmail,
  setToken,
} from "./services/session";
import { getSupabase } from "./services/supabaseClient";
import {
  connectRealtime,
  disconnectRealtime,
  joinInboxRoom,
  leaveInboxRoom,
} from "./services/realtime";
import {
  GoogleAuthError,
  startGoogleSignIn as startNativeGoogleSignIn,
} from "./native/googleAuth";
import { recordOperation } from "./services/monitoring/operations";
import { startPushNotifications, stopPushNotifications } from "./services/pushRuntime";
import { clearUserScopedLocalState } from "./services/userScopedState";
import { aiCredentials } from "./services/aiCredentials";
// W0-B (S2, additive): Google ID-token seam + missing-profile seed. auth.ts,
// session.ts, and userScopedState.ts remain the owners of their behavior.
import {
  getNeedsProfileSeed,
  signInWithGoogleIdToken,
  type GoogleProfileSeed,
  type GoogleSignInOutcome,
} from "./services/auth/googleSignIn";

export type RegisterOutcome =
  | { status: "authenticated"; user: PublicUser }
  | { status: "pending"; email: string };

interface AuthContextValue {
  user: PublicUser | null;
  /** True while we try to hydrate a stored session on boot. */
  booting: boolean;
  /** Non-null when boot could not reach the backend (session kept, Retry offered). */
  bootError: string | null;
  /** Re-run the boot restore after a boot error. */
  retryBoot: () => void;
  /** Email awaiting pending-signup verification (Supabase Confirm-email ON). */
  pendingEmail: string | null;
  login: (email: string, password: string) => Promise<PublicUser>;
  register: (input: {
    username: string;
    email: string;
    phone: string;
    password: string;
  }) => Promise<RegisterOutcome>;
  /** Verify a pending-signup email OTP; establishes the first session. */
  verifyPendingEmail: (code: string) => Promise<PublicUser>;
  /** Resend the pending-signup confirmation code. */
  resendPendingEmail: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: PublicUser) => void;
  /** W0-B (S2, additive): bridge token → Supabase session. Returns the user
   *  when authenticated, or null when routed to completion (see needsProfile). */
  signInWithGoogle: (mode: "signin" | "signup") => Promise<PublicUser | null>;
  /** W0-B (S2, additive): set when a valid session has no FindBack profile
   *  (new Google account or interrupted completion). The session is KEPT —
   *  this state never signs the user out. */
  needsProfile: GoogleProfileSeed | null;
  /** W0-B (S2, additive): dismiss the completion state (after completeSocialProfile). */
  clearNeedsProfile: () => void;
  /** X1 (web OAuth): adopt the outcome resolved by the external callback bridge. */
  adoptExternalAuthOutcome: (outcome: GoogleSignInOutcome) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [pendingEmail, setPendingEmailState] = useState<string | null>(() => getPendingEmail());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  // W0-B (S2, additive): social profile-completion state. Independent of user;
  // a valid session with no profile row sets this WITHOUT signing out.
  const [needsProfile, setNeedsProfileState] = useState<GoogleProfileSeed | null>(null);

  const runBoot = useCallback(() => {
    let cancelled = false;
    setBooting(true);
    setBootError(null);
    void (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled) {
          // W0-B (S2, additive): a loaded profile is complete by definition.
          setNeedsProfileState(null);
          setUserState(restored);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof BootTimeoutError) {
          // Backend unreachable: keep the stored session and user data, offer
          // Retry. Never assume signed-out and never destroy the session here.
          setBootError("unreachable");
        } else {
          // W0-B (S2, additive): a valid session without a FindBack profile
          // (new Google account or interrupted completion) routes to
          // completion — the session is KEPT, clearAllAuth is NOT called.
          const seed = await getNeedsProfileSeed().catch(() => null);
          if (cancelled) return;
          if (seed) {
            setNeedsProfileState(seed);
          } else {
            clearAllAuth();
            setPendingEmailState(null);
          }
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Boot: restore a stored Supabase session.
  useEffect(() => runBoot(), [runBoot]);

  // Keep the token cache and user state in sync with Supabase Auth.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = getSupabase().auth.onAuthStateChange((event, session) => {
        setToken(session?.access_token ?? null);
        if (event === "SIGNED_OUT") {
          aiCredentials.clearSession();
          disconnectRealtime();
          clearUserScopedLocalState();
          setUserState(null);
          setPendingEmailState(null);
          setNeedsProfileState(null); // W0-B (S2, additive): completion cannot outlive the session.
          return;
        }
        if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
          // Defer network work: awaiting Supabase inside this callback can deadlock.
          setTimeout(() => {
            void fetchMe()
              .then((next) => setUserState(next))
              .catch(() => {
                /* ignore transient profile fetch errors */
              });
          }, 0);
        }
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      /* Supabase not configured; boot handling already cleared state */
    }
    return () => unsubscribe?.();
  }, []);

  // A failed mid-session refresh signs the user out in place.
  useEffect(
    () =>
      onSignedOut(() => {
        aiCredentials.clearSession();
        disconnectRealtime();
        clearUserScopedLocalState();
        setUserState(null);
        setPendingEmailState(null);
        setNeedsProfileState(null); // W0-B (S2, additive): see SIGNED_OUT above.
      }),
    [],
  );

  useEffect(() => {
    if (user) {
      connectRealtime();
      joinInboxRoom(user.id);
      void startPushNotifications();
    } else {
      leaveInboxRoom();
      disconnectRealtime();
      void stopPushNotifications();
    }
  }, [user]);

  const setUser = useCallback((next: PublicUser) => setUserState(next), []);

  const refreshUser = useCallback(async () => {
    setUserState(await fetchMe());
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const next = await apiLogin({ email, password });
    setNeedsProfileState(null); // W0-B (S2, additive): password login is a complete profile.
    setUserState(next);
    return next;
  }, []);

  const register = useCallback(
    async (input: { username: string; email: string; phone: string; password: string }) => {
      const result = await apiRegister(input);
      if (result.emailVerificationRequired) {
        const email = result.email ?? input.email;
        persistPendingEmail(email);
        setPendingEmailState(email);
        return { status: "pending", email } as const;
      }
      setNeedsProfileState(null); // W0-B (S2, additive): registered profile is complete.
      setUserState(result.user);
      return { status: "authenticated", user: result.user } as const;
    },
    [],
  );

  const verifyPendingEmail = useCallback(
    async (code: string) => {
      if (!pendingEmail) throw new Error("No pending email verification");
      const next = await verifyPendingEmailCode(pendingEmail, code);
      persistPendingEmail(null);
      setPendingEmailState(null);
      setNeedsProfileState(null); // W0-B (S2, additive): verified profile is complete.
      setUserState(next);
      return next;
    },
    [pendingEmail],
  );

  const resendPendingEmail = useCallback(async () => {
    if (!pendingEmail) throw new Error("No pending email verification");
    await sendPendingEmailCode(pendingEmail);
  }, [pendingEmail]);

  const logout = useCallback(async () => {
    // Account A -> B switch starts here: drop this session's token cache and
    // pending email and notify signed-out handlers BEFORE the sign-out call,
    // so no A-owned slice can leak into the next account's calls.
    beginAccountSwitch();
    // Capture the account before clearing state: signing out wipes that
    // account's AI provider credentials (session + persisted/remembered
    // keys) from this device by default.
    const accountId = user?.id ?? null;
    // Unregister this device's push token while the session is still valid,
    // then clear auth. The user->null effect's stop() is then a no-op.
    await stopPushNotifications();
    try {
      await apiLogout();
    } catch {
      /* best effort: local state is cleared regardless */
    }
    clearAllAuth();
    if (accountId) {
      try {
        await aiCredentials.removeAccountCredentials(accountId);
      } catch {
        /* fail-closed: a purge failure must not block logout */
      }
    }
    aiCredentials.clearSession();
    setPendingEmailState(null);
    setNeedsProfileState(null); // W0-B (S2, additive): completion cannot outlive the session.
    disconnectRealtime();
    clearUserScopedLocalState();
    setUserState(null);
  }, [user]);

  // Coordinator integration (S1 landed): full Google flow — S1 bridge token
  // → S2 seam → auth state. Static S1 import with the typed kind taxonomy;
  // cancel is detected via `kind`, never message matching.
  const clearNeedsProfile = useCallback(() => setNeedsProfileState(null), []);

  /**
   * X1: adopt an outcome already resolved by the external callback bridge (web
   * Google OAuth). Mirrors the native path: authenticated → user; needsProfile
   * → keep the session and surface the completion seed.
   */
  const adoptExternalAuthOutcome = useCallback((outcome: GoogleSignInOutcome) => {
    if (outcome.status === "authenticated") {
      setNeedsProfileState(null);
      setUserState(outcome.user);
      return;
    }
    setNeedsProfileState(outcome.seed);
  }, []);

  const signInWithGoogle = useCallback(async (mode: "signin" | "signup") => {
    let idToken = "";
    let nonce = "";
    try {
      const result = await startNativeGoogleSignIn({ mode });
      idToken = typeof result?.idToken === "string" ? result.idToken : "";
      nonce = typeof result?.nonce === "string" ? result.nonce : "";
    } catch (err) {
      // S1 GoogleAuthError messages are already human (contract) — rethrow
      // verbatim so the taxonomy survives to the UI.
      if (err instanceof GoogleAuthError && err.kind === "cancelled") {
        // Seam: result code only (mode), never tokens/profiles.
        recordOperation({ name: "auth.google.cancelled", fields: { mode } });
        throw new Error("Google sign-in was cancelled.");
      }
      // Seam: stable kind token only.
      recordOperation({
        name: "auth.google.error",
        fields: {
          mode,
          code: err instanceof GoogleAuthError ? err.kind : "unknown",
        },
      });
      if (err instanceof Error) throw err;
      throw new Error("Google sign-in failed. Please try again.");
    }
    if (!idToken) {
      // Seam: result code only.
      recordOperation({ name: "auth.google.error", fields: { mode, code: "no_token" } });
      throw new Error("Google sign-in did not return a token. Please try again.");
    }
    // W0-D: forward the S1 raw nonce for the Supabase server-side nonce
    // check (skip-nonce-check stays OFF). Missing nonce fails closed in S2.
    let outcome: Awaited<ReturnType<typeof signInWithGoogleIdToken>>;
    try {
      outcome = await signInWithGoogleIdToken(idToken, nonce);
    } catch (err) {
      // Seam: result code only.
      recordOperation({ name: "auth.google.error", fields: { mode, code: "exchange_failed" } });
      throw err;
    }
    // Seam: result code only (mode), never tokens/profiles.
    recordOperation({ name: "auth.google.success", fields: { mode } });
    if (outcome.status === "authenticated") {
      setNeedsProfileState(null);
      setUserState(outcome.user);
      return outcome.user;
    }
    setNeedsProfileState(outcome.seed);
    return null;
  }, []);

  const value = useMemo(
    () => ({
      user,
      booting,
      bootError,
      retryBoot: runBoot,
      pendingEmail,
      login,
      register,
      verifyPendingEmail,
      resendPendingEmail,
      logout,
      refreshUser,
      setUser,
      signInWithGoogle,
      needsProfile,
      clearNeedsProfile,
      adoptExternalAuthOutcome,
    }),
    [
      user,
      booting,
      bootError,
      runBoot,
      pendingEmail,
      login,
      register,
      verifyPendingEmail,
      resendPendingEmail,
      logout,
      refreshUser,
      setUser,
      signInWithGoogle,
      needsProfile,
      clearNeedsProfile,
      adoptExternalAuthOutcome,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
