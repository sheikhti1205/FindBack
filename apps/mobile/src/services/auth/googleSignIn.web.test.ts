// @vitest-environment jsdom
/**
 * X1/X17 — web (browser) Google OAuth lane: strategy selection, the OAuth
 * redirect builder, callback completion, and the ONE shared resolver.
 *
 * Fakes sit at the Supabase seam (a fake client) and at the native-availability
 * probe; the real session token cache and the real resolver run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllAuth, getToken } from "../session";
import type { PublicUser } from "@findback/shared";

const hoisted = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  isGoogleAuthAvailable: vi.fn(),
  fetchMe: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getSession: vi.fn(),
  signInWithIdToken: vi.fn(),
  getUser: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => hoisted.isNativePlatform() },
}));

vi.mock("../../native/googleAuth", () => ({
  isGoogleAuthAvailable: () => hoisted.isGoogleAuthAvailable(),
}));

vi.mock("../supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      signInWithOAuth: (...args: unknown[]) => hoisted.signInWithOAuth(...args),
      exchangeCodeForSession: (...args: unknown[]) => hoisted.exchangeCodeForSession(...args),
      getSession: (...args: unknown[]) => hoisted.getSession(...args),
      signInWithIdToken: (...args: unknown[]) => hoisted.signInWithIdToken(...args),
      getUser: (...args: unknown[]) => hoisted.getUser(...args),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: (...args: unknown[]) => hoisted.single(...args) }) }),
    }),
  }),
}));

vi.mock("../auth", () => ({
  fetchMe: (...args: unknown[]) => hoisted.fetchMe(...args),
}));

import {
  completeGoogleWebCallback,
  googleAuthStrategy,
  googleOAuthRedirectTo,
  resolveCurrentGoogleSessionOutcome,
  signInWithGoogleWebOAuth,
} from "./googleSignIn";
import { ApiError } from "../session";

const USER: PublicUser = {
  id: "u-web",
  username: "webuser",
  email: "web@example.com",
  phone: "01812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
};

function sessionResult(accessToken = "web-session-token") {
  return {
    data: { session: { access_token: accessToken, user: { id: "u-web" } }, user: { id: "u-web" } },
    error: null,
  };
}

beforeEach(() => {
  clearAllAuth();
  for (const fn of Object.values(hoisted)) fn.mockReset();
  hoisted.isNativePlatform.mockReturnValue(false);
  hoisted.isGoogleAuthAvailable.mockReturnValue(false);
  hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("googleAuthStrategy — capability, not technology", () => {
  it("prefers native on Android even when a browser is present", () => {
    expect(
      googleAuthStrategy({
        nativeAvailable: () => true,
        isBrowser: () => true,
        supabaseConfigured: () => true,
      }),
    ).toBe("android-native");
  });

  it("uses web OAuth on a browser when native is absent and Supabase is configured", () => {
    expect(
      googleAuthStrategy({
        nativeAvailable: () => false,
        isBrowser: () => true,
        supabaseConfigured: () => true,
      }),
    ).toBe("web-oauth");
  });

  it("is unavailable when neither native nor a configured browser exists", () => {
    expect(
      googleAuthStrategy({
        nativeAvailable: () => false,
        isBrowser: () => false,
        supabaseConfigured: () => true,
      }),
    ).toBe("unavailable");
    expect(
      googleAuthStrategy({
        nativeAvailable: () => false,
        isBrowser: () => true,
        supabaseConfigured: () => false,
      }),
    ).toBe("unavailable");
  });

  it("never throws even when a probe does", () => {
    expect(
      googleAuthStrategy({
        nativeAvailable: () => {
          throw new Error("boom");
        },
        isBrowser: () => true,
        supabaseConfigured: () => true,
      }),
    ).toBe("web-oauth");
  });
});

describe("googleOAuthRedirectTo", () => {
  it("builds the absolute callback URL and normalizes trailing slashes", () => {
    expect(googleOAuthRedirectTo("https://findbackapp.social")).toBe(
      "https://findbackapp.social/auth/callback",
    );
    expect(googleOAuthRedirectTo("https://findbackapp.social/")).toBe(
      "https://findbackapp.social/auth/callback",
    );
  });
});

describe("signInWithGoogleWebOAuth", () => {
  it("hands the browser to Supabase signInWithOAuth for the google provider", async () => {
    hoisted.signInWithOAuth.mockResolvedValue({ data: { provider: "google", url: "x" }, error: null });
    await signInWithGoogleWebOAuth();
    expect(hoisted.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({
          redirectTo: "http://localhost:3000/auth/callback",
          skipBrowserRedirect: false,
        }),
      }),
    );
  });

  it("maps a provider rejection to a human message without internals", async () => {
    hoisted.signInWithOAuth.mockResolvedValue({
      data: { provider: null, url: null },
      error: { code: "provider_disabled_internal", message: "raw oauth detail" },
    });
    const err = await signInWithGoogleWebOAuth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).not.toContain("provider_disabled_internal");
    expect((err as Error).message).not.toContain("raw oauth detail");
  });

  it("refuses to start on a non-allowlisted origin (never an open redirect)", async () => {
    vi.stubGlobal("location", { origin: "https://evil.example.com" });
    await expect(signInWithGoogleWebOAuth()).rejects.toMatchObject({ name: "ApiError" });
    expect(hoisted.signInWithOAuth).not.toHaveBeenCalled();
  });
});

describe("completeGoogleWebCallback — the ONE shared resolver", () => {
  it("exchanges the code, stores the session, and resolves an existing profile", async () => {
    hoisted.exchangeCodeForSession.mockResolvedValue(sessionResult());
    hoisted.fetchMe.mockResolvedValue({ ...USER });

    const outcome = await completeGoogleWebCallback("code-abc");

    expect(hoisted.exchangeCodeForSession).toHaveBeenCalledWith("code-abc");
    expect(getToken()).toBe("web-session-token");
    expect(outcome).toEqual({ status: "authenticated", user: USER });
  });

  it("returns a needsProfile seed when the session has no profile and keeps the session", async () => {
    hoisted.exchangeCodeForSession.mockResolvedValue(sessionResult("kept-session"));
    hoisted.fetchMe.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({
      data: { user: { id: "u-web", email: "web@example.com", user_metadata: { name: "Web User" } } },
      error: null,
    });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116", status: 406 } });

    const outcome = await completeGoogleWebCallback("code-for-new");

    expect(outcome.status).toBe("needsProfile");
    if (outcome.status === "needsProfile") {
      expect(outcome.seed.email).toBe("web@example.com");
      expect(outcome.seed.name).toBe("Web User");
    }
    expect(getToken()).toBe("kept-session");
  });

  it("rejects an empty code without touching Supabase", async () => {
    await expect(completeGoogleWebCallback("")).rejects.toMatchObject({ name: "ApiError" });
    expect(hoisted.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("maps an exchange failure to a human message without the code", async () => {
    hoisted.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_grant", message: "raw exchange detail for code-abc" },
    });
    const err = await completeGoogleWebCallback("code-abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).not.toContain("invalid_grant");
    expect((err as Error).message).not.toContain("code-abc");
  });
});

describe("resolveCurrentGoogleSessionOutcome", () => {
  it("throws when there is no stored session", async () => {
    hoisted.getSession.mockResolvedValue({ data: { session: null } });
    await expect(resolveCurrentGoogleSessionOutcome()).rejects.toMatchObject({ name: "ApiError" });
  });

  it("resolves the stored session into the shared outcome", async () => {
    hoisted.getSession.mockResolvedValue({ data: { session: { access_token: "stored-token" } } });
    hoisted.fetchMe.mockResolvedValue({ ...USER });
    const outcome = await resolveCurrentGoogleSessionOutcome();
    expect(getToken()).toBe("stored-token");
    expect(outcome).toEqual({ status: "authenticated", user: USER });
  });
});

describe("privacy guards (web lane)", () => {
  it("never logs the PKCE code or the provider token", async () => {
    const seen: unknown[][] = [];
    const methods = ["log", "warn", "error", "debug", "info"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        seen.push(args);
      }),
    );
    try {
      hoisted.signInWithOAuth.mockResolvedValue({ data: {}, error: null });
      await signInWithGoogleWebOAuth().catch(() => {});
      hoisted.exchangeCodeForSession.mockResolvedValue(sessionResult("token-must-not-leak"));
      hoisted.fetchMe.mockResolvedValue({ ...USER });
      await completeGoogleWebCallback("code-must-not-leak").catch(() => {});
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const dumped = JSON.stringify(seen);
    expect(dumped).not.toContain("code-must-not-leak");
    expect(dumped).not.toContain("token-must-not-leak");
  });

  it("does not reference a Google web client secret or Firebase Auth", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(__dirname, "googleSignIn.ts"), "utf8");
    expect(source).not.toContain("GOOGLE_WEB_CLIENT_SECRET");
    expect(source).not.toMatch(/client_secret/i);
    expect(source).not.toMatch(/firebase/i);
  });
});
