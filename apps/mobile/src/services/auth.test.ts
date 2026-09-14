import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";
import {
  clearAllAuth,
  getPendingEmail,
  getRefreshToken,
  getToken,
  onSignedOut,
  setPendingEmail,
  setRefreshToken,
  setToken,
} from "./api";
import {
  fetchMe,
  login,
  logout,
  persistSession,
  register,
  restoreSession,
  sendPendingEmailCode,
  verifyPendingEmailCode,
} from "./auth";
import { socketAuth } from "./realtime";

const USER: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "01812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const REGISTER_INPUT = {
  username: "tester",
  email: "tester@example.com",
  phone: "01812345678",
  password: "password123",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  clearAllAuth();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile session model", () => {
  it("login persists access + refresh tokens", async () => {
    fetchMock.mockResolvedValueOnce(json({ token: "a1", refreshToken: "r1", user: USER }));
    const res = await login({ identifier: "tester", password: "pw" });
    persistSession(res);
    expect(getToken()).toBe("a1");
    expect(getRefreshToken()).toBe("r1");
  });

  it("pending registration returns no token and shows pending email", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ user: USER, emailVerificationRequired: true, email: USER.email }),
    );
    const res = await register(REGISTER_INPUT);
    expect(res.emailVerificationRequired).toBe(true);
    if (res.emailVerificationRequired) expect(res.email).toBe(USER.email);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it("local/legacy registration returns an immediate token", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ token: "a1", user: USER, emailVerificationRequired: false }),
    );
    const res = await register(REGISTER_INPUT);
    expect(res.emailVerificationRequired).toBe(false);
    if (!res.emailVerificationRequired) expect(res.token).toBe("a1");
  });

  it("OTP verification returns a session that persists access + refresh tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ token: "a2", refreshToken: "r2", emailVerified: true, phoneVerified: false, user: USER }),
    );
    const res = await verifyPendingEmailCode(USER.email, "123456");
    persistSession(res);
    expect(getToken()).toBe("a2");
    expect(getRefreshToken()).toBe("r2");
  });

  it("resend posts to the public pending-email endpoint", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await sendPendingEmailCode(USER.email);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/auth/email-verification/send");
  });
});

describe("one-time 401 -> refresh -> retry", () => {
  it("refreshes once and retries with the new access token", async () => {
    setToken("old");
    setRefreshToken("r1");
    fetchMock
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ token: "new", refreshToken: "r2" }))
      .mockResolvedValueOnce(json({ user: USER }));

    const u = await fetchMe();
    expect(u.id).toBe("u1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retry = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(new Headers(retry[1].headers).get("authorization")).toBe("Bearer new");
    expect(getRefreshToken()).toBe("r2");
  });

  it("collapses concurrent 401s into a single refresh", async () => {
    setToken("old");
    setRefreshToken("r1");
    let refreshCount = 0;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/auth/refresh")) {
        refreshCount += 1;
        return json({ token: "new", refreshToken: "r2" });
      }
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer old" ? json({ error: "expired" }, 401) : json({ user: USER });
    });

    const [a, b] = await Promise.all([fetchMe(), fetchMe()]);
    expect(a.id).toBe("u1");
    expect(b.id).toBe("u1");
    expect(refreshCount).toBe(1);
  });

  it("clears the session and notifies when refresh fails", async () => {
    setToken("old");
    setRefreshToken("r1");
    const signedOut = vi.fn();
    const off = onSignedOut(signedOut);
    fetchMock
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ error: "bad refresh" }, 401));

    await expect(fetchMe()).rejects.toBeTruthy();
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);
    off();
  });

  it("never refreshes on an auth endpoint", async () => {
    setToken("old");
    setRefreshToken("r1");
    fetchMock.mockResolvedValueOnce(json({ error: "invalid credentials" }, 401));

    await expect(login({ identifier: "x", password: "y" })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe("r1");
  });
});

describe("startup restoration and logout", () => {
  it("restores by refreshing when only a refresh token remains", async () => {
    setRefreshToken("r1");
    fetchMock
      .mockResolvedValueOnce(json({ token: "a2", refreshToken: "r2" }))
      .mockResolvedValueOnce(json({ user: USER }));

    const u = await restoreSession();
    expect(u.id).toBe("u1");
    expect(getToken()).toBe("a2");
    expect(getRefreshToken()).toBe("r2");
  });

  it("logout calls the endpoint; local clearing removes both tokens + pending email", async () => {
    setToken("a1");
    setRefreshToken("r1");
    setPendingEmail("pending@example.com");
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    await logout();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/auth/logout");

    clearAllAuth();
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getPendingEmail()).toBeNull();
  });
});

describe("Socket.IO auth", () => {
  it("reads the latest access token on each (re)connection attempt", () => {
    setToken("a1");
    const first = vi.fn();
    socketAuth()(first);
    expect(first).toHaveBeenCalledWith({ token: "a1" });

    setToken("a2");
    const second = vi.fn();
    socketAuth()(second);
    expect(second).toHaveBeenCalledWith({ token: "a2" });
  });
});
