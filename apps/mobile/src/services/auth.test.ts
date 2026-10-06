import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllAuth, getToken, setToken } from "./session";
import {
  askAiHelp,
  checkUsername,
  fetchMe,
  login,
  logout,
  register,
  restoreSession,
  sendPendingEmailCode,
  verifyPendingEmailCode,
  sendPhoneChangeCode,
  verifyPhoneChangeCode,
  saveProfilePhone,
} from "./auth";
import { isLikelySecretKey, SupabaseConfigError, validateSupabaseConfig } from "./supabaseClient";
import { aiCredentials } from "./aiCredentials";

const { clientMock, singleMock, ilikeMock, limitMock, selectMock, isolatedClientMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const limitMock = vi.fn();
  const ilikeMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn();
  const clientMock = {
    auth: {
      signUp: vi.fn(), signInWithPassword: vi.fn(), getSession: vi.fn(), getUser: vi.fn(),
      signOut: vi.fn(), resend: vi.fn(), verifyOtp: vi.fn(), refreshSession: vi.fn(),
      onAuthStateChange: vi.fn(), updateUser: vi.fn(), setSession: vi.fn(),
      dispose: vi.fn(),
    },
    rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() },
  };
  return {
    singleMock,
    limitMock,
    ilikeMock,
    selectMock,
    clientMock,
    isolatedClientMock: vi.fn((_url: string, _key: string, _options?: Parameters<typeof import("@supabase/supabase-js").createClient>[2]) => ({ auth: clientMock.auth })),
  };
});

vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@supabase/supabase-js")>(),
  createClient: isolatedClientMock,
}));

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

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mockProfile(): void {
  clientMock.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue({ data: PROFILE_ROW, error: null });
}

beforeEach(() => {
  isolatedClientMock.mockClear();
  clearAllAuth();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const fn of Object.values(clientMock.auth)) fn.mockReset();
  clientMock.rpc.mockReset();
  clientMock.from.mockReset();
  clientMock.functions.invoke.mockReset();
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
    expect(isLikelySecretKey("sb_" + "secret_abcdef")).toBe(true);
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

  it("restoreSession raises a timeout instead of hanging when the endpoint stalls", async () => {
    vi.useFakeTimers();
    try {
      clientMock.auth.getSession.mockReturnValue(new Promise(() => undefined));
      const pending = restoreSession();
      const assertion = expect(pending).rejects.toThrow("Session restore timed out");
      await vi.advanceTimersByTimeAsync(12_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchMe", () => {
  it("uses the confirmed auth phone when metadata is absent, never a metadata verified flag", async () => {
    mockProfile();
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, phone: "8801812345678", phone_confirmed_at: "2026-10-06", user_metadata: { phoneVerified: true } } }, error: null });
    singleMock.mockResolvedValue({ data: { ...PROFILE_ROW, phone_verified: 1 }, error: null });
    expect(await fetchMe()).toMatchObject({ phone: "+8801812345678", phoneVerified: true });
  });

  it("fails closed for an edited number even if a stale public row says verified", async () => {
    mockProfile();
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, phone: "8801912345678", phone_confirmed_at: "2026-10-06" } }, error: null });
    singleMock.mockResolvedValue({ data: { ...PROFILE_ROW, phone_verified: 1 }, error: null });
    expect((await fetchMe()).phoneVerified).toBe(false);
  });
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

describe("authenticated phone change", () => {
  beforeEach(() => {
    mockProfile();
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null });
    clientMock.auth.updateUser.mockResolvedValue({ data: { user: USER }, error: null });
    clientMock.auth.resend.mockResolvedValue({ data: {}, error: null });
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: USER, access_token: "original", refresh_token: "original-refresh" } }, error: null });
    clientMock.auth.setSession.mockResolvedValue({ data: {}, error: null });
  });

  it("isolates mutations from persistent account state with refresh disabled", async () => {
    await sendPhoneChangeCode("u1", "01812345678");
    expect(isolatedClientMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }) }));
    expect(clientMock.auth.setSession).toHaveBeenCalledWith({ access_token: "original", refresh_token: "original-refresh" });
    expect(clientMock.auth.dispose).toHaveBeenCalledOnce();
  });

  it("disposes transient auth even when session initialization fails", async () => {
    clientMock.auth.setSession.mockResolvedValue({ data: {}, error: { code: "invalid_grant", message: "Invalid grant" } });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow();
    expect(clientMock.auth.dispose).toHaveBeenCalledOnce();
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it.each(["01812345678", "8801812345678", "+8801812345678", "018-1234 5678"])("sends a real phone change request normalized from %s", async (phone) => {
    await sendPhoneChangeCode("u1", phone);
    expect(clientMock.auth.updateUser).toHaveBeenCalledWith({ phone: "+8801812345678" });
    expect(clientMock.auth.resend).not.toHaveBeenCalled();
  });

  it("resends only the existing matching phone change challenge", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null });
    await sendPhoneChangeCode("u1", "01812345678", true);
    expect(clientMock.auth.resend).toHaveBeenCalledWith({ type: "phone_change", phone: "+8801812345678" });
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it("verifies phone_change and reloads the server-owned public badge", async () => {
    const confirmed = { ...USER, phone: "8801812345678", phone_confirmed_at: "2026-10-06" };
    clientMock.auth.getUser.mockResolvedValueOnce({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null }).mockResolvedValueOnce({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null }).mockResolvedValue({ data: { user: confirmed }, error: null });
    clientMock.auth.verifyOtp.mockResolvedValue({ data: { user: confirmed, session: { access_token: "phone-tok" } }, error: null });
    singleMock.mockResolvedValue({ data: { ...PROFILE_ROW, phone_verified: 1 }, error: null });
    const result = await verifyPhoneChangeCode("u1", "01812345678", "123456");
    expect(clientMock.auth.verifyOtp).toHaveBeenCalledWith({ phone: "+8801812345678", token: "123456", type: "phone_change" });
    expect(result.phoneVerified).toBe(true);
    expect(getToken()).toBeNull(); // The existing global session is never replaced.
  });

  it("saves an edited number without sending SMS or setting a verified boolean", async () => {
    await saveProfilePhone("u1", "01912345678");
    expect(clientMock.auth.updateUser).toHaveBeenCalledWith({ data: { phone: "+8801912345678" } });
    expect(clientMock.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects invalid numbers and malformed codes before any OTP request", async () => {
    await expect(sendPhoneChangeCode("u1", "01212345678")).rejects.toThrow(/valid Bangladesh/i);
    for (const code of ["12345", "12345678901", "abcdef"]) {
      await expect(verifyPhoneChangeCode("u1", "01812345678", code)).rejects.toThrow(/invalid or expired/i);
    }
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
    expect(clientMock.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects a switched account before sending or saving", async () => {
    await expect(sendPhoneChangeCode("other", "01812345678")).rejects.toThrow(/account changed/i);
    await expect(saveProfilePhone("other", "01912345678")).rejects.toThrow(/account changed/i);
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects a destination mismatch and a missing or changed challenge", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    await expect(sendPhoneChangeCode("u1", "01912345678")).rejects.toThrow(/number changed/i);
    await expect(verifyPhoneChangeCode("u1", "01812345678", "123456")).rejects.toThrow(/send a new code/i);
    await expect(sendPhoneChangeCode("u1", "01812345678", true)).rejects.toThrow(/send a new code/i);
    expect(clientMock.auth.verifyOtp).not.toHaveBeenCalled();
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
    expect(clientMock.auth.resend).not.toHaveBeenCalled();
  });

  it.each([
    ["otp_expired", 400, /invalid or expired/i],
    ["over_sms_send_rate_limit", 429, /too many/i],
    ["sms_send_failed", 500, /SMS.*could not.*sent/i],
    ["phone_provider_disabled", 400, /SMS.*not enabled/i],
    ["phone_exists", 400, /already.*account/i],
  ])("maps phone provider error %s without exposing internals", async (code, status, message) => {
    clientMock.auth.updateUser.mockResolvedValue({ data: { user: null }, error: { code, status, message: "private provider internals" } });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow(message);
  });

  it("does not return another account's profile after a request race", async () => {
    clientMock.auth.getUser.mockResolvedValueOnce({ data: { user: USER }, error: null }).mockResolvedValue({ data: { user: { ...USER, id: "other" } }, error: null });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow(/account changed/i);
  });

  it("rechecks the destination after establishing the isolated session", async () => {
    clientMock.auth.getUser.mockResolvedValueOnce({ data: { user: USER }, error: null }).mockResolvedValue({ data: { user: { ...USER, user_metadata: { phone: "01912345678" } } }, error: null });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow(/number changed/i);
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it("does not claim SMS was sent when Auth did not create a phone-change challenge", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow(/no SMS confirmation is pending/i);
  });

  it("rejects a switched local session before creating a mutation client", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "other" } } }, error: null });
    await expect(sendPhoneChangeCode("u1", "01812345678")).rejects.toThrow(/account changed/i);
    expect(isolatedClientMock).not.toHaveBeenCalled();
    expect(clientMock.auth.updateUser).not.toHaveBeenCalled();
  });

  it.each(["otp_expired", "invalid_otp", "over_request_rate_limit"])("surfaces %s on verification without modifying the global token", async (code) => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null });
    clientMock.auth.verifyOtp.mockResolvedValue({ data: { user: null }, error: { code, message: "internal" } });
    await expect(verifyPhoneChangeCode("u1", "01812345678", "123456")).rejects.toThrow(code === "over_request_rate_limit" ? /too many/i : /invalid or expired/i);
    expect(getToken()).toBeNull();
  });

  it("fails closed if the returned identity differs, even with a successful OTP response", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { ...USER, new_phone: "8801812345678" } }, error: null });
    clientMock.auth.verifyOtp.mockResolvedValue({ data: { user: { id: "other" }, session: { access_token: "other" } }, error: null });
    await expect(verifyPhoneChangeCode("u1", "01812345678", "123456")).rejects.toThrow(/account changed/i);
    expect(getToken()).toBeNull();
  });

  it("exercises real SDK phone_change serialization with a fake HTTP transport and no persistent session replacement", async () => {
    const { createClient } = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    const pending = { ...USER, new_phone: "8801812345678" };
    const confirmed = { ...USER, phone: "8801812345678", phone_confirmed_at: "2026-10-06T12:00:00Z" };
    const jwt = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }))}.${base64url("synthetic-signature")}`;
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: pending, access_token: jwt, refresh_token: "synthetic-refresh" } }, error: null });
    clientMock.auth.getUser.mockResolvedValueOnce({ data: { user: pending }, error: null }).mockResolvedValueOnce({ data: { user: pending }, error: null }).mockResolvedValue({ data: { user: confirmed }, error: null });
    singleMock.mockResolvedValue({ data: { ...PROFILE_ROW, phone_verified: 1 }, error: null });
    const http = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/verify")) {
        return new Response(JSON.stringify({ user: confirmed, access_token: jwt, refresh_token: "otp-refresh", token_type: "bearer", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(pending), { status: 200 });
    });
    isolatedClientMock.mockImplementationOnce((_url, _key, options) => createClient("https://example.invalid", "sb_publishable_test", { ...options, global: { fetch: http } }) as unknown as ReturnType<typeof isolatedClientMock>);
    setToken("existing-global-token");
    const result = await verifyPhoneChangeCode("u1", "01812345678", "123456");
    expect(result.phoneVerified).toBe(true);
    const request = http.mock.calls.find(([url]) => String(url).endsWith("/verify"));
    expect(JSON.parse(request![1]!.body as string)).toMatchObject({ phone: "+8801812345678", token: "123456", type: "phone_change" });
    expect(clientMock.auth.verifyOtp).not.toHaveBeenCalled();
    expect(getToken()).toBe("existing-global-token");
  });
});

describe("checkUsername", () => {
  it("reports an unused username as available and returns it lowercased", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    const res = await checkUsername("  New_User  ");
    expect(res).toEqual({ available: true, normalized: "new_user" });
    expect(clientMock.rpc).toHaveBeenCalledWith("is_username_available", {
      p_username: "new_user",
    });
    expect(clientMock.from).not.toHaveBeenCalled();
  });

  it("reports an existing username as unavailable", async () => {
    clientMock.rpc.mockResolvedValue({ data: false, error: null });
    const res = await checkUsername("Taken");
    expect(res).toEqual({ available: false, normalized: "taken" });
  });

  it("treats a null RPC result as unavailable (fail closed)", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    const res = await checkUsername("taken");
    expect(res).toEqual({ available: false, normalized: "taken" });
  });

  it("falls back to the direct lookup only when the RPC is not deployed", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function is_username_available" },
    });
    limitMock.mockResolvedValue({ data: [{ username: "taken" }], error: null });
    const res = await checkUsername("Taken");
    expect(res).toEqual({ available: false, normalized: "taken" });
    expect(clientMock.from).toHaveBeenCalledWith("users");
  });

  it("queries case-insensitively with the lowercased value", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing is_username_available" },
    });
    limitMock.mockResolvedValue({ data: [], error: null });
    await checkUsername("TaWsIf");
    expect(ilikeMock).toHaveBeenCalledWith("username", "tawsif");
  });

  it("escapes underscore so it is matched literally, not as a wildcard", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing is_username_available" },
    });
    limitMock.mockResolvedValue({ data: [], error: null });
    await checkUsername("a_b");
    expect(ilikeMock).toHaveBeenCalledWith("username", "a\\_b");
  });

  it("rejects an invalid username without querying Supabase", async () => {
    await expect(checkUsername("ab")).rejects.toThrow("Invalid username");
    await expect(checkUsername("has space")).rejects.toThrow("Invalid username");
    expect(clientMock.rpc).not.toHaveBeenCalled();
    expect(clientMock.from).not.toHaveBeenCalled();
    expect(ilikeMock).not.toHaveBeenCalled();
  });

  it("maps a Supabase error to ApiError", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(checkUsername("valid_user")).rejects.toThrow("boom");
  });

  it("never calls the Node API", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    await checkUsername("valid_user");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("askAiHelp", () => {
  it("answers without a key from built-in FAQ without calling any AI provider", async () => {
    aiCredentials.clearSession();
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    const res = await askAiHelp("how do I report a lost item?");
    expect(res.source).toBe("fallback");
    expect(res.text.toLowerCase()).toContain("report");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientMock.functions.invoke).not.toHaveBeenCalled();
  });

  it("uses the user's key and exactly openrouter/free; labels generated answers", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Tap Report." } }] }), { status: 200 }));
    const res = await askAiHelp("where do I report?");
    expect(res).toEqual({ text: "Tap Report.", source: "llm" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string).model).toBe("openrouter/free");
    expect(clientMock.functions.invoke).not.toHaveBeenCalled();
    aiCredentials.clearSession();
  });

  it("falls back to a built-in answer after free allowance exhaustion", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 429, message: "daily limit reached" } }), { status: 429 }));
    const res = await askAiHelp("how do I search?");
    expect(res.source).toBe("fallback");
    expect(res.text.toLowerCase()).toContain("search");
    aiCredentials.clearSession();
  });

  it("falls back honestly on a 402 payment/policy block without any paid retry", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 402, message: "Payment required" } }), { status: 402 }));
    const res = await askAiHelp("how do I search?");
    expect(res.source).toBe("fallback");
    expect(res.text).toContain("never uses paid models");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).model).toBe("openrouter/free");
    expect(clientMock.functions.invoke).not.toHaveBeenCalled();
    aiCredentials.clearSession();
  });

  it("sends policy, knowledge and untrusted question layers inside the transport bound", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Tap Report." } }] }), { status: 200 }));

    const question = `How do I report a lost item? ${"with extra detail ".repeat(20)}`.slice(0, 500);
    const res = await askAiHelp(question);
    expect(res.source).toBe("llm");

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      messages: { role: string; content: string }[];
    };
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain("[system-policy version=");
    expect(prompt).toContain("[knowledge version=");
    const labelAt = prompt.indexOf("[untrusted user text");
    expect(labelAt).toBeGreaterThan(prompt.indexOf("[knowledge version="));
    expect(prompt.indexOf(question.slice(0, 60))).toBeGreaterThan(labelAt);
    expect(prompt.length).toBeLessThanOrEqual(2400);
    aiCredentials.clearSession();
  });

  it("never returns a SQL or private-contact answer from the model", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "SELECT email, phone FROM profiles WHERE id = 1;" } }] }), { status: 200 }));
    const sql = await askAiHelp("how do I search?");
    expect(sql.source).toBe("fallback");
    expect(sql.text.toUpperCase()).not.toContain("SELECT");
    expect(sql.text.toLowerCase()).not.toContain("profiles");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "The poster is jane.doe@example.com." } }] }), { status: 200 }));
    const privateData = await askAiHelp("how do I comment?");
    expect(privateData.source).toBe("fallback");
    expect(privateData.text).not.toContain("@example.com");
    expect(clientMock.functions.invoke).not.toHaveBeenCalled();
    aiCredentials.clearSession();
  });

  it("keeps a long generated answer intact instead of silently cutting it at 1200 characters", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    await aiCredentials.connect("u1", "example-user-key", { remember: false });
    const tail = "the final line must survive the transport.";
    const body = `${"Step by step: open the Report tab and add the details. ".repeat(40)}${tail}`;
    expect(body.length).toBeGreaterThan(1200);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: body } }] }), { status: 200 }));

    const res = await askAiHelp("how do I report?");
    expect(res.source).toBe("llm");
    expect(res.text.length).toBeGreaterThan(1200);
    expect(res.text.endsWith(tail)).toBe(true);
    aiCredentials.clearSession();
  });
});
