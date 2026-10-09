// @vitest-environment jsdom
/**
 * W0-B (S2) — Google ID-token service seam.
 *
 * Red→green: this file is written FIRST against a non-existent module.
 * Fakes sit at the seam (fake Supabase client, mocked fetchMe, real session
 * token cache). A successful login is never faked in production paths — the
 * fake client only returns canned session/error shapes the tests dictate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllAuth, getToken } from "../session";
import { getPendingReportRoute, rememberReportLink } from "../../utils/pendingReportLink";
import type { PublicUser } from "@findback/shared";

const hoisted = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  signInWithIdToken: vi.fn(),
  getUser: vi.fn(),
  single: vi.fn(),
  rpc: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      signInWithIdToken: (...args: unknown[]) => hoisted.signInWithIdToken(...args),
      getUser: (...args: unknown[]) => hoisted.getUser(...args),
      signOut: (...args: unknown[]) => hoisted.signOut(...args),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: (...args: unknown[]) => hoisted.single(...args) }) }),
    }),
    rpc: (...args: unknown[]) => hoisted.rpc(...args),
  }),
}));

vi.mock("../auth", () => ({
  fetchMe: (...args: unknown[]) => hoisted.fetchMe(...args),
}));

import {
  completeSocialProfile,
  isProfileMissingError,
  signInWithGoogleIdToken,
  suggestUsername,
} from "./googleSignIn";
import { ApiError } from "../session";

const TOKEN = "w0b-test-id-token-abc123";
const NONCE = "w0d-test-raw-nonce-xyz789";

const EXISTING_USER: PublicUser = {
  id: "user-existing",
  username: "oldname",
  email: "same@example.com",
  phone: "01812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function sessionResult() {
  return {
    data: {
      session: { access_token: "session-token-1", user: { id: "user-existing" } },
      user: { id: "user-existing" },
    },
    error: null,
  };
}

function googleAuthUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-new",
    email: "new.person@example.com",
    user_metadata: {
      name: "New Person",
      avatar_url: "https://lh3.googleusercontent.com/a/avatar123",
      ...overrides,
    },
    phone_confirmed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  clearAllAuth();
  sessionStorage.clear();
  for (const fn of Object.values(hoisted)) fn.mockReset();
  hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("isProfileMissingError — narrow PGRST116 check", () => {
  it("is true only for the PostgREST missing-row code", () => {
    expect(isProfileMissingError({ code: "PGRST116", status: 406, message: "x" })).toBe(true);
  });
  it("never matches on message text alone", () => {
    expect(isProfileMissingError({ code: "23505", message: "contains PGRST116 as text" })).toBe(false);
    expect(isProfileMissingError({ message: "PGRST116" })).toBe(false);
    expect(isProfileMissingError(new ApiError("Could not load profile", 400))).toBe(false);
    expect(isProfileMissingError(null)).toBe(false);
    expect(isProfileMissingError(undefined)).toBe(false);
    expect(isProfileMissingError("PGRST116")).toBe(false);
  });
});

describe("signInWithGoogleIdToken — nonce forwarding (W0-D)", () => {
  it("forwards the raw nonce into Supabase signInWithIdToken", async () => {
    hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
    hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER });

    await signInWithGoogleIdToken(TOKEN, NONCE);

    expect(hoisted.signInWithIdToken).toHaveBeenCalledWith({ provider: "google", token: TOKEN, nonce: NONCE });
  });

  it("rejects an empty nonce without touching Supabase", async () => {
    await expect(signInWithGoogleIdToken(TOKEN, "")).rejects.toMatchObject({ name: "ApiError" });
    expect(hoisted.signInWithIdToken).not.toHaveBeenCalled();
  });
});

describe("signInWithGoogleIdToken — existing profile (path A)", () => {
  it("sets the session token and returns the preserved profile untouched", async () => {
    hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
    hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER });

    const outcome = await signInWithGoogleIdToken(TOKEN, NONCE);

    expect(hoisted.signInWithIdToken).toHaveBeenCalledWith({ provider: "google", token: TOKEN, nonce: NONCE });
    expect(getToken()).toBe("session-token-1");
    expect(outcome).toEqual({ status: "authenticated", user: EXISTING_USER });
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });

  it("preserves a same-email password account: newer Google metadata never overwrites it", async () => {
    hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
    // Google supplies newer display metadata for the linked identity, but the
    // stored FindBack profile (old username/phone/avatar) must win verbatim.
    hoisted.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-existing",
          email: "same@example.com",
          user_metadata: { name: "Shiny New Name", avatar_url: "https://lh3.googleusercontent.com/a/new" },
        },
      },
      error: null,
    });
    hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER });

    const outcome = await signInWithGoogleIdToken(TOKEN, NONCE);

    expect(outcome.status).toBe("authenticated");
    if (outcome.status === "authenticated") {
      expect(outcome.user.username).toBe("oldname");
      expect(outcome.user.phone).toBe("01812345678");
      expect(outcome.user.avatarUrl).toBeNull();
      expect(outcome.user).toEqual(EXISTING_USER);
    }
    expect(hoisted.rpc).not.toHaveBeenCalled();
    expect(hoisted.signOut).not.toHaveBeenCalled();
  });
});

describe("signInWithGoogleIdToken — missing profile (path B)", () => {
  function missingProfileSetup() {
    hoisted.signInWithIdToken.mockResolvedValue({
      data: { session: { access_token: "session-token-new", user: { id: "user-new" } }, user: { id: "user-new" } },
      error: null,
    });
    hoisted.fetchMe.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: googleAuthUser() }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116", status: 406 } });
  }

  it("keeps the session and returns a needsProfile seed", async () => {
    missingProfileSetup();

    const outcome = await signInWithGoogleIdToken(TOKEN, NONCE);

    expect(outcome.status).toBe("needsProfile");
    if (outcome.status === "needsProfile") {
      expect(outcome.seed.email).toBe("new.person@example.com");
      expect(outcome.seed.name).toBe("New Person");
      expect(outcome.seed.avatarUrl).toBe("https://lh3.googleusercontent.com/a/avatar123");
      expect(outcome.seed.phone).toBe("");
      expect(outcome.seed.suggestedUsername).toBe("new_person");
    }
    // Session is KEPT: never signed out, never wiped for a missing row.
    expect(getToken()).toBe("session-token-new");
    expect(hoisted.signOut).not.toHaveBeenCalled();
  });

  it("sanitizes a non-Google avatar to null in the seed", async () => {
    missingProfileSetup();
    hoisted.getUser.mockResolvedValue({
      data: { user: googleAuthUser({ avatar_url: "https://evil.example/x.png" }) },
      error: null,
    });

    const outcome = await signInWithGoogleIdToken(TOKEN, NONCE);
    expect(outcome.status).toBe("needsProfile");
    if (outcome.status === "needsProfile") expect(outcome.seed.avatarUrl).toBeNull();
  });

  it("rethrows when the profile probe finds a different failure", async () => {
    hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
    const original = new ApiError("Could not load profile", 400);
    hoisted.fetchMe.mockRejectedValue(original);
    hoisted.getUser.mockResolvedValue({ data: { user: googleAuthUser() }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });

    await expect(signInWithGoogleIdToken(TOKEN, NONCE)).rejects.toBe(original);
    expect(getToken()).toBe("session-token-1");
  });
});

describe("signInWithGoogleIdToken — rejections", () => {
  it("rejects an empty token without touching Supabase", async () => {
    await expect(signInWithGoogleIdToken("", NONCE)).rejects.toMatchObject({ name: "ApiError" });
    expect(hoisted.signInWithIdToken).not.toHaveBeenCalled();
  });

  it("maps a Supabase rejection to a human message without raw internals", async () => {
    hoisted.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_jwt_xyz", message: "JWT aud mismatch internal detail", status: 400 },
    });

    const err = await signInWithGoogleIdToken(TOKEN, NONCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const message = (err as Error).message;
    expect(message).not.toContain("invalid_jwt_xyz");
    expect(message).not.toContain("aud mismatch");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("suggestUsername — local suggestion, never a claim", () => {
  it("derives deterministic suggestions from name or email local-part", () => {
    expect(suggestUsername("Sheikh Aftab", "other@example.com")).toBe("sheikh_aftab");
    expect(suggestUsername(null, "John.Doe@example.com")).toBe("john_doe");
    expect(suggestUsername("  Amina  Hossain  ", "x@example.com")).toBe("amina_hossain");
  });
  it("always returns a pattern-valid value, even for short or hostile input", () => {
    const pattern = /^[A-Za-z0-9_]{3,20}$/;
    for (const got of [
      suggestUsername("Al", "al@example.com"),
      suggestUsername("!!!", "???@example.com"),
      suggestUsername(null, "a@b.co"),
      suggestUsername("A Very Long Display Name Beyond Twenty Chars", "x@example.com"),
      suggestUsername(null, "not-an-email"),
    ]) {
      expect(got).toMatch(pattern);
    }
  });
  it("truncates to 20 characters", () => {
    expect(suggestUsername("A Very Long Display Name Beyond Twenty Chars", "x@example.com").length).toBeLessThanOrEqual(20);
  });
  it("never consults the availability oracle (suggestion is not a claim)", async () => {
    suggestUsername("Taken Name", "taken@example.com");
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });
});

describe("completeSocialProfile", () => {
  const VALID = {
    username: "new_person",
    displayName: "New Person",
    phone: "01812345678",
    avatarUrl: "https://lh3.googleusercontent.com/a/avatar123",
  };

  beforeEach(() => {
    hoisted.rpc.mockResolvedValue({ data: null, error: null });
    hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER, username: "new_person" });
  });

  it("calls the staged RPC with exact args then returns the created profile", async () => {
    const user = await completeSocialProfile(VALID);

    expect(hoisted.rpc).toHaveBeenCalledWith("complete_social_profile", {
      p_username: "new_person",
      p_phone: "01812345678",
      p_display_name: "New Person",
      p_avatar_url: "https://lh3.googleusercontent.com/a/avatar123",
    });
    expect(user.username).toBe("new_person");
    // Google phone is prefill only: phoneVerified stays false without Supabase SMS proof.
    expect(user.phoneVerified).toBe(false);
  });

  it("sends null for a non-Google avatar URL", async () => {
    await completeSocialProfile({ ...VALID, avatarUrl: "https://evil.example/x.png" });
    expect(hoisted.rpc).toHaveBeenCalledWith(
      "complete_social_profile",
      expect.objectContaining({ p_avatar_url: null }),
    );
  });

  it("rejects a bad username locally without calling the RPC", async () => {
    await expect(completeSocialProfile({ ...VALID, username: "ab" })).rejects.toMatchObject({ name: "ApiError", status: 400 });
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });

  it("rejects a non-BD phone locally without calling the RPC", async () => {
    await expect(completeSocialProfile({ ...VALID, phone: "+14155552671" })).rejects.toMatchObject({ name: "ApiError", status: 400 });
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });

  it("maps a taken username to the human duplicate message (unavailable cannot finalize)", async () => {
    hoisted.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "ux_users_username_lower"' },
    });

    const err = await completeSocialProfile(VALID).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ApiError", status: 409 });
    expect((err as Error).message).not.toContain("ux_users_username_lower");
    expect((err as Error).message.length).toBeGreaterThan(0);
  });
});

describe("privacy guards", () => {
  it("never writes the provider token to any console sink", async () => {
    const seen: unknown[][] = [];
    const methods = ["log", "warn", "error", "debug", "info"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      seen.push(args);
    }));
    try {
      hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
      hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER });
      await signInWithGoogleIdToken(TOKEN, NONCE);
      hoisted.fetchMe.mockRejectedValueOnce(new ApiError("Could not load profile", 400));
      hoisted.getUser.mockResolvedValue({ data: { user: googleAuthUser() }, error: null });
      hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
      hoisted.signInWithIdToken.mockResolvedValueOnce({
        data: { session: { access_token: "t2", user: { id: "user-new" } }, user: { id: "user-new" } },
        error: null,
      });
      await signInWithGoogleIdToken(TOKEN, NONCE);
      await completeSocialProfile({
        username: "new_person",
        displayName: "New Person",
        phone: "01812345678",
        avatarUrl: null,
      }).catch(() => {});
    } finally {
      for (const s of spies) s.mockRestore();
    }
    for (const args of seen) {
      for (const arg of args) {
        expect(String(arg)).not.toContain(TOKEN);
      }
    }
  });

  it("contains no secret key material or token logging in its own source", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(__dirname, "googleSignIn.ts"), "utf8");
    expect(source).not.toContain("sb_secret_");
    expect(source).not.toContain("service_role");
    expect(source).not.toMatch(/console\.(log|warn|error|debug|info)/);
  });

  it("preserves the pending-report destination across both outcomes", async () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://share.example.com");
    const postId = "123e4567-e89b-12d3-a456-426614174000";
    rememberReportLink(`https://share.example.com/r/${postId}`);
    const before = getPendingReportRoute();
    expect(before).not.toBeNull();

    hoisted.signInWithIdToken.mockResolvedValue(sessionResult());
    hoisted.fetchMe.mockResolvedValue({ ...EXISTING_USER });
    await signInWithGoogleIdToken(TOKEN, NONCE);
    expect(getPendingReportRoute()).toBe(before);

    hoisted.fetchMe.mockRejectedValueOnce(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: googleAuthUser() }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    hoisted.signInWithIdToken.mockResolvedValueOnce({
      data: { session: { access_token: "t2", user: { id: "user-new" } }, user: { id: "user-new" } },
      error: null,
    });
    await signInWithGoogleIdToken(TOKEN, NONCE);
    expect(getPendingReportRoute()).toBe(before);
  });
});
