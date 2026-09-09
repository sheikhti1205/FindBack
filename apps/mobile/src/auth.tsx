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
  register as apiRegister,
} from "./services/auth";
import { getToken, setToken } from "./services/api";
import { connectRealtime, disconnectRealtime } from "./services/realtime";

interface AuthContextValue {
  user: PublicUser | null;
  /** True while we try to hydrate a stored session on boot. */
  booting: boolean;
  login: (identifier: string, password: string) => Promise<PublicUser>;
  register: (input: {
    username: string;
    email: string;
    phone: string;
    password: string;
  }) => Promise<PublicUser>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  setUser: (user: PublicUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setBooting(false);
      return;
    }
    fetchMe()
      .then((u) => {
        if (!cancelled) setUserState(u);
      })
      .catch(() => {
        if (!cancelled) setToken(null);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (user) connectRealtime();
    else disconnectRealtime();
  }, [user]);

  const setUser = useCallback((u: PublicUser) => setUserState(u), []);

  const refreshUser = useCallback(async () => {
    const u = await fetchMe();
    setUserState(u);
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const { token, user: u } = await apiLogin({ identifier, password });
    setToken(token);
    setUserState(u);
    return u;
  }, []);

  const register = useCallback(
    async (input: { username: string; email: string; phone: string; password: string }) => {
      const { token, user: u } = await apiRegister(input);
      setToken(token);
      setUserState(u);
      return u;
    },
    [],
  );

  const logout = useCallback(() => {
    setToken(null);
    disconnectRealtime();
    setUserState(null);
  }, []);

  const value = useMemo(
    () => ({ user, booting, login, register, logout, refreshUser, setUser }),
    [user, booting, login, register, logout, refreshUser, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
