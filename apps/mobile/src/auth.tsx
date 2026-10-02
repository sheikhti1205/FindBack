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
import { startPushNotifications, stopPushNotifications } from "./services/pushRuntime";
import { clearUserScopedLocalState } from "./services/userScopedState";
import { aiCredentials } from "./services/aiCredentials";

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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [pendingEmail, setPendingEmailState] = useState<string | null>(() => getPendingEmail());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const runBoot = useCallback(() => {
    let cancelled = false;
    setBooting(true);
    setBootError(null);
    void (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled) setUserState(restored);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof BootTimeoutError) {
          // Backend unreachable: keep the stored session and user data, offer
          // Retry. Never assume signed-out and never destroy the session here.
          setBootError("unreachable");
        } else {
          clearAllAuth();
          setPendingEmailState(null);
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
    // Unregister this device's push token while the session is still valid,
    // then clear auth. The user->null effect's stop() is then a no-op.
    await stopPushNotifications();
    try {
      await apiLogout();
    } catch {
      /* best effort: local state is cleared regardless */
    }
    clearAllAuth();
    aiCredentials.clearSession();
    setPendingEmailState(null);
    disconnectRealtime();
    clearUserScopedLocalState();
    setUserState(null);
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
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
