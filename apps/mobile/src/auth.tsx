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
import { clearSessionExpired, markSessionExpired, sessionExpiryCandidate } from "./services/sessionExpiry";
import { ApiError } from "./services/session";
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
  const sdkObserved = useRef(false);
  const profileAdoptionBlocked = useRef(false);
  const authEpoch = useRef(0);
  const hadStoredSession = useRef(sessionExpiryCandidate());
  const intentionalSignOut = useRef(0);
  const assertAccount = useCallback((accountId: string) => {
    if (profileAdoptionBlocked.current || (sdkObserved.current && sdkAccount.current !== accountId)) throw new AuthAccountChangedError();
  }, []);
  const setUserState = useCallback((next: PublicUser | null) => {
    if (next !== null) assertAccount(next.id);
    if (next !== null) clearSessionExpired();
    currentUser.current = next;
    publishUser(next);
  }, [assertAccount]);
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
          setUserState(restored);
          setNeedsProfileState(null);
        }
      } catch (err) {
        if (cancelled || epoch !== authEpoch.current || err instanceof AuthAccountChangedError) return;
        // The initial snapshot's deferred profile load may have succeeded
        // while this overlapping boot request was still pending.
        if (sdkObserved.current && sdkAccount.current !== null && currentUser.current?.id === sdkAccount.current) return;
        if (err instanceof BootTimeoutError) {
          // Backend unreachable: keep the stored session and user data, offer
          // Retry. Never assume signed-out and never destroy the session here.
          setBootError("unreachable");
        } else {
          if (err instanceof ApiError && err.status === 401 && hadStoredSession.current && intentionalSignOut.current === 0) markSessionExpired();
          // W0-B (S2, additive): a valid session without a FindBack profile
          // (new Google account or interrupted completion) routes to
          // completion — the session is KEPT, clearAllAuth is NOT called.
          const seed = await getNeedsProfileSeed().catch(() => null);
          if (cancelled || epoch !== authEpoch.current) return;
          if (seed) {
            if (!sdkObserved.current || seed.accountId === sdkAccount.current) setNeedsProfileState(seed);
          } else if (!sdkObserved.current || sdkAccount.current === null) {
            clearAllAuth();
            setPendingEmailState(null);
          } else {
            setBootError("unreachable");
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
        const previousAccount = sdkAccount.current ?? currentUser.current?.id ?? null;
        if (event === "SIGNED_OUT" && (previousAccount !== null || hadStoredSession.current) && intentionalSignOut.current === 0) markSessionExpired();
        if (session) clearSessionExpired();
        if (event === "SIGNED_OUT") hadStoredSession.current = false;
        const nextAccount = session?.user.id ?? null;
        const accountChanged = previousAccount !== null && previousAccount !== nextAccount;
        // The SDK's startup snapshot is part of the boot restore, not a new
        // auth attempt. Do not invalidate that restore for the same slot.
        const epoch = event === "INITIAL_SESSION" && !accountChanged
          ? authEpoch.current : ++authEpoch.current;
        sdkAccount.current = nextAccount;
        sdkObserved.current = true;
        if (event === "SIGNED_OUT" || nextAccount === null) profileAdoptionBlocked.current = true;
        // SIGNED_IN can reconfirm the same session on tab refocus. Only a
        // changed SDK slot may reopen adoption after local sign-out.
        else if (previousAccount !== nextAccount) profileAdoptionBlocked.current = false;
        setToken(profileAdoptionBlocked.current ? null : session?.access_token ?? null);
        if (event === "SIGNED_OUT" || accountChanged) {
          // SDK replacement need not emit SIGNED_OUT. Invalidate A's private
          // slices synchronously, before scheduling B's profile fetch. The
          // shared AI reset aborts A's flight but retains verified downloads.
          // Do not clearAllAuth here: the SDK slot/token already belongs to B.
          aiCredentials.clearSession();
          disconnectRealtime();
          clearUserScopedLocalState();
          setUserState(null);
          persistPendingEmail(null);
          setPendingEmailState(null);
          setNeedsProfileState(null);
          if (event === "SIGNED_OUT") return;
        }
        if (!profileAdoptionBlocked.current && nextAccount !== null && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED" || event === "INITIAL_SESSION")) {
          // Defer network work: awaiting Supabase inside this callback can deadlock.
          setTimeout(() => {
            void fetchMe(session?.user.id)
              .then((next) => {
                if (epoch === authEpoch.current) {
                  setUserState(next);
                  ++authEpoch.current; // This owned result supersedes overlapping boot work.
                  setNeedsProfileState(null);
                  setBootError(null);
                  setBooting(false);
                }
              })
              .catch(async () => {
                if (epoch !== authEpoch.current) return;
                const seed = await getNeedsProfileSeed(nextAccount).catch(() => null);
                if (seed && !profileAdoptionBlocked.current && epoch === authEpoch.current && seed.accountId === sdkAccount.current) {
                  ++authEpoch.current;
                  setNeedsProfileState(seed);
                  setBootError(null);
                  setBooting(false);
                }
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
        if (currentUser.current && intentionalSignOut.current === 0) markSessionExpired();
        ++authEpoch.current;
        profileAdoptionBlocked.current = true;
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
      void startPushNotifications({
        accountId: user.id,
        isCurrent: () => currentUser.current?.id === user.id &&
          (!sdkObserved.current || sdkAccount.current === user.id) && !profileAdoptionBlocked.current,
      });
    } else {
      leaveInboxRoom();
      disconnectRealtime();
      // Rehydration is not logout. Clearing cached native admission here would
      // discard a legitimate cold notification tap before its session loads.
      if (!booting) void stopPushNotifications();
    }
  }, [user, booting]);

  const setUser = useCallback((next: PublicUser) => setUserState(next), []);

  const refreshUser = useCallback(async () => {
    const epoch = authEpoch.current;
    const next = await fetchMe();
    if (epoch === authEpoch.current) setUserState(next);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const next = await apiLogin({ email, password });
    assertAccount(next.id);
    setNeedsProfileState(null); // W0-B (S2, additive): password login is a complete profile.
    setUserState(next);
    return next;
  }, []);

  const register = useCallback(
    async (input: { username: string; email: string; phone: string; password: string }) => {
      const epoch = authEpoch.current;
      const result = await apiRegister(input);
      if (result.emailVerificationRequired) {
        if (epoch !== authEpoch.current || profileAdoptionBlocked.current) throw new AuthAccountChangedError();
        const email = result.email ?? input.email;
        persistPendingEmail(email);
        setPendingEmailState(email);
        return { status: "pending", email } as const;
      }
      assertAccount(result.user.id);
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
      assertAccount(next.id);
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
    intentionalSignOut.current += 1;
    hadStoredSession.current = false;
    clearSessionExpired();
    try {
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
    } finally { intentionalSignOut.current -= 1; }
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
      assertAccount(outcome.user.id);
      setNeedsProfileState(null);
      setUserState(outcome.user);
      return;
    }
    assertAccount(outcome.seed.accountId);
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
      assertAccount(outcome.user.id);
      setNeedsProfileState(null);
      setUserState(outcome.user);
      return outcome.user;
    }
    assertAccount(outcome.seed.accountId);
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
