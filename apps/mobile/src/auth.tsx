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
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  persistSession,
  register as apiRegister,
  restoreSession,
  sendPendingEmailCode,
  verifyPendingEmailCode,
  type AuthSessionPayload,
} from "./services/auth";
import {
  clearAllAuth,
  getPendingEmail,
  getRefreshToken,
  getToken,
  onSignedOut,
  setPendingEmail as persistPendingEmail,
} from "./services/api";
import { connectRealtime, disconnectRealtime } from "./services/realtime";

export type RegisterOutcome =
  | { status: "authenticated"; user: PublicUser }
  | { status: "pending"; email: string };

interface AuthContextValue {
  user: PublicUser | null;
  /** True while we try to hydrate a stored session on boot. */
  booting: boolean;
  /** Email awaiting pending-signup verification (Supabase Confirm-email ON). */
  pendingEmail: string | null;
  login: (identifier: string, password: string) => Promise<PublicUser>;
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
  logout: () => void;
  refreshUser: () => Promise<void>;
  setUser: (user: PublicUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [pendingEmail, setPendingEmailState] = useState<string | null>(() => getPendingEmail());
  const [booting, setBooting] = useState(true);

  // Boot: restore a stored session (refreshing an expired access token once).
  useEffect(() => {
    let cancelled = false;
    if (!getToken() && !getRefreshToken()) {
      setBooting(false);
      return;
    }
    (async () => {
      try {
        const restored = await restoreSession();
        if (!cancelled) setUserState(restored);
      } catch {
        if (!cancelled) {
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

  // A failed mid-session refresh signs the user out in place.
  useEffect(
    () =>
      onSignedOut(() => {
        disconnectRealtime();
        setUserState(null);
        setPendingEmailState(null);
      }),
    [],
  );

  useEffect(() => {
    if (user) connectRealtime();
    else disconnectRealtime();
  }, [user]);

  const setUser = useCallback((next: PublicUser) => setUserState(next), []);

  const refreshUser = useCallback(async () => {
    setUserState(await fetchMe());
  }, []);

  const applySession = useCallback((session: AuthSessionPayload): PublicUser => {
    const next = persistSession(session);
    setUserState(next);
    return next;
  }, []);

  const login = useCallback(
    async (identifier: string, password: string) =>
      applySession(await apiLogin({ identifier, password })),
    [applySession],
  );

  const register = useCallback(
    async (input: { username: string; email: string; phone: string; password: string }) => {
      const result = await apiRegister(input);
      if (result.emailVerificationRequired) {
        persistPendingEmail(result.email);
        setPendingEmailState(result.email);
        return { status: "pending", email: result.email } as const;
      }
      return { status: "authenticated", user: applySession(result) } as const;
    },
    [applySession],
  );

  const verifyPendingEmail = useCallback(
    async (code: string) => {
      if (!pendingEmail) throw new Error("No pending email verification");
      const restored = applySession(await verifyPendingEmailCode(pendingEmail, code));
      persistPendingEmail(null);
      setPendingEmailState(null);
      return restored;
    },
    [pendingEmail, applySession],
  );

  const resendPendingEmail = useCallback(async () => {
    if (!pendingEmail) throw new Error("No pending email verification");
    await sendPendingEmailCode(pendingEmail);
  }, [pendingEmail]);

  const logout = useCallback(() => {
    void (async () => {
      try {
        await apiLogout();
      } catch {
        /* best effort: local state is cleared regardless */
      }
      clearAllAuth();
      setPendingEmailState(null);
      disconnectRealtime();
      setUserState(null);
    })();
  }, []);

  const value = useMemo(
    () => ({
      user,
      booting,
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
