import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, API_URL, clearAllAuth, getToken, onSignedOut } from "./api";
import {
  checkUsername,
  fetchMe,
  login,
  logout,
  register,
  restoreSession,
  sendPendingEmailCode,
  verifyPendingEmailCode,
} from "./auth";
import { isLikelySecretKey, SupabaseConfigError, validateSupabaseConfig } from "./supabaseClient";

const { clientMock, singleMock, ilikeMock, limitMock, selectMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const limitMock = vi.fn();
  const ilikeMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn();
  return {
    singleMock,
    limitMock,
    ilikeMock,
    selectMock,
    clientMock: {
      auth: {
        signUp: vi.fn(),
        signInWithPassword: vi.fn(),
        getSession: vi.fn(),
        getUser: vi.fn(),
        signOut: vi.fn(),
        resend: vi.fn(),
        verifyOtp: vi.fn(),
        refreshSession: vi.fn(),
        onAuthStateChange: vi.fn(),
      },
      rpc: vi.fn(),
      from: vi.fn(),
    },
  };
});

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

const REGISTER_INPUT = {
  username: "tester",
  email: "tester@example.com",
  phone: "01812345678",
  password: "password123",
};

const PROFILE_ROW = {
  id: "u1",
  username: "tester",
  email_verified: true,
  phone_verified: false,
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const USER = {
  id: "u1",
  email: "tester@example.com",
  user_metadata: { phone: "01812345678" },
};

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mockProfile(): void {
  clientMock.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue({ data: PROFILE_ROW, error: null });
}

beforeEach(() => {
  clearAllAuth();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const fn of Object.values(clientMock.auth)) fn.mockReset();
  clientMock.rpc.mockReset();
  clientMock.from.mockReset();
  clientMock.from.mockImplementation(() => ({ select: selectMock }));
  selectMock.mockReset();
  selectMock.mockImplementation(() => ({
    eq: () => ({ single: singleMock }),
    ilike: ilikeMock,
  }));
  ilikeMock.mockClear();
  limitMock.mockReset();
  singleMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supabase config validation", () => {
  it("throws on an empty url", () => {
    expect(() => validateSupabaseConfig("", "sb_publishable_abc")).toThrow(SupabaseConfigError);
  });

  it("throws on an empty key", () => {
    expect(() => validateSupabaseConfig("https://x.supabase.co", "")).toThrow(SupabaseConfigError);
  });

  it("throws on a non-http url", () => {
    expect(() => validateSupabaseConfig("ftp://x.supabase.co", "sb_publishable_abc")).toThrow(
      SupabaseConfigError,
    );
  });

  it("returns trimmed values for a valid-looking publishable config", () => {
    expect(
      validateSupabaseConfig("  https://x.supabase.co  ", "  sb_publishable_abc  "),
    ).toEqual({ url: "https://x.supabase.co", key: "sb_publishable_abc" });
  });

  it("rejects a service_role JWT (no secret value is ever used)", () => {
    const serviceRoleJwt = `header.${base64url(JSON.stringify({ role: "service_role" }))}.signature`;
    expect(isLikelySecretKey(serviceRoleJwt)).toBe(true);
    expect(() => validateSupabaseConfig("https://x.supabase.co", serviceRoleJwt)).toThrow(
      SupabaseConfigError,
    );
  });

  it("rejects sb_secret_ keys and accepts sb_publishable_ keys", () => {
    expect(isLikelySecretKey("sb_secret_abcdef")).toBe(true);
    expect(isLikelySecretKey("sb_publishable_abcdef")).toBe(false);
    expect(isLikelySecretKey("not-a-jwt")).toBe(false);
  });
});

describe("register", () => {
  it("returns pending when signUp yields no session", async () => {
    clientMock.auth.signUp.mockResolvedValue({
      data: {
        user: {
          id: "u1",
          email: "tester@example.com",
          created_at: "2026-01-01T00:00:00.000Z",
          identities: [{ id: "i1" }],
        },
        session: null,
      },
      error: null,
    });
    const res = await register(REGISTER_INPUT);
    expect(res.emailVerificationRequired).toBe(true);
    expect(res.email).toBe("tester@example.com");
    expect(res.user.id).toBe("u1");
    expect(getToken()).toBeNull();
  });

  it("returns an authenticated user when signUp yields a session", async () => {
    clientMock.auth.signUp.mockResolvedValue({
      data: {
        user: { id: "u1", email: "tester@example.com", identities: [{ id: "i1" }] },
        session: { access_token: "tok" },
      },
      error: null,
    });
    mockProfile();
    const res = await register(REGISTER_INPUT);
    expect(res.emailVerificationRequired).toBe(false);
    expect(res.user.username).toBe("tester");
    expect(getToken()).toBe("tok");
  });

  it("treats an empty-identity user as a duplicate", async () => {
    clientMock.auth.signUp.mockResolvedValue({
      data: { user: { id: "u1", email: "tester@example.com", identities: [] }, session: null },
      error: null,
    });
    await expect(register(REGISTER_INPUT)).rejects.toThrow(/already exists/i);
  });
});

describe("login", () => {
  it("signs in directly with email and password", async () => {
    clientMock.auth.signInWithPassword.mockResolvedValue({
      data: { user: USER, session: { access_token: "tok" } },
      error: null,
    });
    mockProfile();
    const u = await login({ email: "tester@example.com", password: "pw" });
    expect(u.id).toBe("u1");
    expect(clientMock.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "tester@example.com",
      password: "pw",
    });
  });

  it("never performs a username lookup (email-only login)", async () => {
    clientMock.auth.signInWithPassword.mockResolvedValue({
      data: { user: USER, session: { access_token: "tok" } },
      error: null,
    });
    mockProfile();
    await login({ email: "tester@example.com", password: "pw" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps invalid credentials to a friendly error", async () => {
    clientMock.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials", code: "invalid_credentials", status: 400 },
    });
    await expect(login({ email: "tester@example.com", password: "bad" })).rejects.toThrow(
      "Invalid credentials",
    );
  });
});

describe("pending email verification", () => {
  it("verifies a code and returns the user", async () => {
    clientMock.auth.verifyOtp.mockResolvedValue({
      data: { user: USER, session: { access_token: "tok" } },
      error: null,
    });
    mockProfile();
    const u = await verifyPendingEmailCode("tester@example.com", "123456");
    expect(u.id).toBe("u1");
    expect(getToken()).toBe("tok");
  });

  it("rejects malformed codes before calling Supabase", async () => {
    await expect(verifyPendingEmailCode("tester@example.com", "12")).rejects.toThrow(
      "Invalid or expired verification code",
    );
    expect(clientMock.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("maps an expired code to a friendly error", async () => {
    clientMock.auth.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Token has expired or is invalid", code: "otp_expired", status: 400 },
    });
    await expect(verifyPendingEmailCode("tester@example.com", "123456")).rejects.toThrow(
      "Invalid or expired verification code",
    );
  });

  it("swallows enumeration errors on resend", async () => {
    clientMock.auth.resend.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "User not found", code: "user_not_found", status: 400 },
    });
    await expect(sendPendingEmailCode("missing@example.com")).resolves.toBeUndefined();
  });
});

describe("session lifecycle", () => {
  it("logout signs out of Supabase", async () => {
    clientMock.auth.signOut.mockResolvedValue({ error: null });
    await logout();
    expect(clientMock.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("restoreSession throws when there is no session", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(restoreSession()).rejects.toThrow("Session expired");
  });

  it("restoreSession returns the user when a session exists", async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "tok" } },
      error: null,
    });
    mockProfile();
    const u = await restoreSession();
    expect(u.id).toBe("u1");
    expect(getToken()).toBe("tok");
  });
});

describe("fetchMe", () => {
  it("reads safe profile columns and sources identity from the session", async () => {
    mockProfile();
    const u = await fetchMe();
    expect(u.username).toBe("tester");
    expect(u.email).toBe("tester@example.com");
    expect(u.phone).toBe("01812345678");
    expect(u.emailVerified).toBe(true);
    expect(u.phoneVerified).toBe(false);
  });

  it("never selects the private email/phone columns from users", async () => {
    mockProfile();
    await fetchMe();
    const columns = (selectMock.mock.calls[0]![0] as string)
      .split(",")
      .map((c) => c.trim());
    expect(columns).toContain("username");
    expect(columns).toContain("email_verified");
    expect(columns).not.toContain("email");
    expect(columns).not.toContain("phone");
  });

  it("throws when there is no authenticated user", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(fetchMe()).rejects.toThrow("Not authenticated");
  });
});

describe("legacy Node API bridge", () => {
  it("sends the Supabase access token to the legacy Node URL", async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "sb-token" } },
      error: null,
    });
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    await apiFetch("/posts");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/posts`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sb-token");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    clientMock.auth.getSession
      .mockResolvedValueOnce({ data: { session: { access_token: "old" } }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: "new" } }, error: null });
    clientMock.auth.refreshSession.mockResolvedValue({
      data: { session: { access_token: "new" } },
      error: null,
    });
    fetchMock
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ ok: true }));

    const res = await apiFetch<{ ok: boolean }>("/me/posts");

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(retry[1].headers).get("authorization")).toBe("Bearer new");
  });

  it("clears the session and notifies when refresh fails", async () => {
    clientMock.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "old" } },
      error: null,
    });
    clientMock.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: "bad refresh", code: "refresh_token_not_found" },
    });
    const signedOut = vi.fn();
    const off = onSignedOut(signedOut);
    fetchMock.mockResolvedValueOnce(json({ error: "expired" }, 401));

    await expect(apiFetch("/me/posts")).rejects.toBeTruthy();

    expect(getToken()).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("checkUsername", () => {
  it("reports an unused username as available and returns it lowercased", async () => {
    limitMock.mockResolvedValue({ data: [], error: null });
    const res = await checkUsername("  New_User  ");
    expect(res).toEqual({ available: true, normalized: "new_user" });
    expect(clientMock.from).toHaveBeenCalledWith("users");
  });

  it("reports an existing username as unavailable", async () => {
    limitMock.mockResolvedValue({ data: [{ username: "taken" }], error: null });
    const res = await checkUsername("Taken");
    expect(res).toEqual({ available: false, normalized: "taken" });
  });

  it("queries case-insensitively with the lowercased value", async () => {
    limitMock.mockResolvedValue({ data: [], error: null });
    await checkUsername("TaWsIf");
    expect(ilikeMock).toHaveBeenCalledWith("username", "tawsif");
  });

  it("escapes underscore so it is matched literally, not as a wildcard", async () => {
    limitMock.mockResolvedValue({ data: [], error: null });
    await checkUsername("a_b");
    expect(ilikeMock).toHaveBeenCalledWith("username", "a\\_b");
  });

  it("rejects an invalid username without querying Supabase", async () => {
    await expect(checkUsername("ab")).rejects.toThrow("Invalid username");
    await expect(checkUsername("has space")).rejects.toThrow("Invalid username");
    expect(clientMock.from).not.toHaveBeenCalled();
    expect(ilikeMock).not.toHaveBeenCalled();
  });

  it("maps a Supabase error to ApiError", async () => {
    limitMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(checkUsername("valid_user")).rejects.toThrow("boom");
  });

  it("never calls the Node API", async () => {
    limitMock.mockResolvedValue({ data: [], error: null });
    await checkUsername("valid_user");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
