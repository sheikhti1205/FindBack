import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { AuthAccountChangedError } from "./services/accountScopedAuthStorage";
import { storage } from "./services/storage";
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
  deletionCompletion: { accountId: string; state: "cleaning" | "complete" | "cleanup-failed" } | null;
  finishAccountDeletion: (accountId: string) => Promise<void>;
  retryDeletionCleanup: () => Promise<void>;
  dismissDeletionCompletion: () => void;
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
const DELETION_CLEANUP_KEY = "findback.auth.deletedAccountCleanup";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, publishUser] = useState<PublicUser | null>(null);
  const currentUser = useRef<PublicUser | null>(null);
  const sdkAccount = useRef<string | null>(null);
  const authEpoch = useRef(0);
  const setUserState = useCallback((next: PublicUser | null) => {
    currentUser.current = next;
    publishUser(next);
  }, []);
  const [deletionCompletion, setDeletionCompletion] = useState<AuthContextValue["deletionCompletion"]>(() => {
    try {
      const accountId = storage.getItem(DELETION_CLEANUP_KEY);
      return accountId ? { accountId, state: "cleanup-failed" } : null;
    } catch { return null; }
  });
  const [pendingEmail, setPendingEmailState] = useState<string | null>(() => getPendingEmail());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  // W0-B (S2, additive): social profile-completion state. Independent of user;
  // a valid session with no profile row sets this WITHOUT signing out.
  const [needsProfile, setNeedsProfileState] = useState<GoogleProfileSeed | null>(null);

  const runBoot = useCallback(() => {
    const epoch = authEpoch.current;
    let cancelled = false;
    setBooting(true);
    setBootError(null);
    void (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled && epoch === authEpoch.current) {
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
        const epoch = ++authEpoch.current;
        sdkAccount.current = session?.user.id ?? null;
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
            void fetchMe(session?.user.id)
              .then((next) => { if (epoch === authEpoch.current) setUserState(next); })
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

  const deviceSignedOut = useCallback(() => currentUser.current === null && sdkAccount.current === null, []);

  const cleanAccountOnDevice = useCallback(async (accountId: string | null) => {
    // Account A -> B switch starts here: drop this session's token cache and
    // pending email and notify signed-out handlers BEFORE the sign-out call,
    // so no A-owned slice can leak into the next account's calls.
    const switched = () => (sdkAccount.current !== null && sdkAccount.current !== accountId)
      || (currentUser.current !== null && currentUser.current.id !== accountId);
    if (!switched()) beginAccountSwitch();
    // Capture the account before clearing state: signing out wipes that
    // account's AI provider credentials (session + persisted/remembered keys)
    // from this device by default. This runs BEFORE any switch check, so a
    // switch cannot abandon A's keys — and a purge failure is never swallowed.
    let keysFailed = false;
    let sessionFailed = false;
    if (accountId) {
      try {
        await aiCredentials.removeAccountCredentials(accountId);
      } catch {
        keysFailed = true;
      }
    }
    if (!switched()) {
      try { await stopPushNotifications(); } catch { /* Push teardown cannot block auth cleanup. */ }
    }
    // A switch must never clear or sign out the account that replaced A, but a
    // real cleanup failure for A still has to surface so it can be retried.
    if (switched()) {
      if (keysFailed) throw new Error("Stored AI keys could not be removed. Retry cleanup on this device.");
      return;
    }
    try { await apiLogout(accountId ?? undefined); }
    catch (error) {
      // The persistence boundary refused because A's slot now holds B: A's
      // session is already gone, so nothing to clean, but keys still surface.
      if (error instanceof AuthAccountChangedError) {
        if (keysFailed) throw new Error("Stored AI keys could not be removed. Retry cleanup on this device.");
        return;
      }
      sessionFailed = true;
    }
    if (switched()) {
      if (keysFailed || sessionFailed) throw new Error("Stored sign-in or AI keys could not be removed. Retry cleanup on this device.");
      return;
    }
    clearAllAuth();
    aiCredentials.clearSession();
    setPendingEmailState(null);
    setNeedsProfileState(null); // W0-B (S2, additive): completion cannot outlive the session.
    disconnectRealtime();
    clearUserScopedLocalState();
    setUserState(null);
    if (keysFailed || sessionFailed) throw new Error("Stored sign-in or AI keys could not be removed. Retry cleanup on this device.");
  }, [setUserState]);

  const logout = useCallback(() => cleanAccountOnDevice(currentUser.current?.id ?? sdkAccount.current), [cleanAccountOnDevice]);

  const finishAccountDeletion = useCallback(async (accountId: string) => {
    if (currentUser.current?.id !== accountId) throw new Error("Your account changed. Open the current account to continue.");
    storage.setItem(DELETION_CLEANUP_KEY, accountId);
    setDeletionCompletion({ accountId, state: "cleaning" });
    try {
      await logout();
      // "Complete" is only ever shown when the device is genuinely signed out
      // and the persisted session is verifiably gone; a foreign session taking
      // the slot means A's cleanup is done (A's keys were purged) but there is
      // nothing left for the user to act on.
      if (deviceSignedOut()) setDeletionCompletion({ accountId, state: "complete" });
      else setDeletionCompletion(null);
      storage.removeItem(DELETION_CLEANUP_KEY);
    } catch (error) {
      const foreign = currentUser.current !== null && currentUser.current.id !== accountId;
      setDeletionCompletion(foreign ? null : { accountId, state: "cleanup-failed" });
      throw error;
    }
  }, [logout, deviceSignedOut]);

  const retryDeletionCleanup = useCallback(async () => {
    if (!deletionCompletion || deletionCompletion.state === "cleaning" || currentUser.current !== null) return;
    const accountId = deletionCompletion.accountId;
    setDeletionCompletion({ accountId, state: "cleaning" });
    try {
      await cleanAccountOnDevice(accountId);
      if (deviceSignedOut()) setDeletionCompletion({ accountId, state: "complete" });
      else setDeletionCompletion(null);
      storage.removeItem(DELETION_CLEANUP_KEY);
    } catch {
      setDeletionCompletion(deviceSignedOut() ? { accountId, state: "cleanup-failed" } : null);
    }
  }, [deletionCompletion, cleanAccountOnDevice, deviceSignedOut]);
  const dismissDeletionCompletion = useCallback(() => {
    storage.removeItem(DELETION_CLEANUP_KEY);
    setDeletionCompletion(null);
  }, []);

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
      deletionCompletion,
      finishAccountDeletion,
      retryDeletionCleanup,
      dismissDeletionCompletion,
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
      deletionCompletion,
      finishAccountDeletion,
      retryDeletionCleanup,
      dismissDeletionCompletion,
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
