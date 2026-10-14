// @vitest-environment jsdom
/**
 * W0-B (S2) — AuthProvider additive state: needsProfile / clearNeedsProfile /
 * signInWithGoogle + the boot branch (valid session + missing profile → seed,
 * session KEPT, no clearAllAuth).
 *
 * Mirrors the mocking convention of src/auth.test.tsx. The S2 seam
 * (./googleSignIn) is REAL; only its dependencies (services/auth,
 * supabaseClient) are faked. Logout/account-switch cleanup modules are
 * spied, never modified.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const hoisted = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  fetchMe: vi.fn(),
  onAuthStateChange: vi.fn(),
  getUser: vi.fn(),
  single: vi.fn(),
  signOut: vi.fn(),
  clearUserScopedLocalState: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  registerPlugin: vi.fn(),
}));

vi.mock("../auth", () => ({
  BootTimeoutError: class BootTimeoutError extends Error {},
  fetchMe: (...args: unknown[]) => hoisted.fetchMe(...args),
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
  restoreSession: (...args: unknown[]) => hoisted.restoreSession(...args),
  sendPendingEmailCode: vi.fn(),
  verifyPendingEmailCode: vi.fn(),
}));

vi.mock("../supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      onAuthStateChange: (...args: unknown[]) => hoisted.onAuthStateChange(...args),
      getUser: (...args: unknown[]) => hoisted.getUser(...args),
      signOut: (...args: unknown[]) => hoisted.signOut(...args),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: (...args: unknown[]) => hoisted.single(...args) }) }),
    }),
    rpc: vi.fn(),
  }),
}));

vi.mock("../realtime", () => ({
  connectRealtime: vi.fn(),
  disconnectRealtime: vi.fn(),
  joinInboxRoom: vi.fn(),
  leaveInboxRoom: vi.fn(),
}));

vi.mock("../pushRuntime", () => ({
  startPushNotifications: vi.fn(async () => {}),
  stopPushNotifications: vi.fn(async () => {}),
}));

vi.mock("../userScopedState", () => ({
  clearUserScopedLocalState: (...args: unknown[]) => hoisted.clearUserScopedLocalState(...args),
}));

import { AuthProvider, useAuth } from "../../auth";
import type { ComponentType, ReactNode } from "react";
import { ApiError } from "../session";

type Ctx = ReturnType<typeof useAuth>;

function harness(capture: { current: Ctx | null }) {
  const Probe: ComponentType = () => {
    capture.current = useAuth();
    return null;
  };
  return function Harness({ children }: { children?: ReactNode }) {
    void children;
    return (
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
  };
}

const GOOGLE_USER = {
  id: "user-new",
  email: "new.person@example.com",
  user_metadata: { name: "New Person", avatar_url: "https://lh3.googleusercontent.com/a/x" },
};

beforeEach(() => {
  hoisted.restoreSession.mockReset();
  hoisted.fetchMe.mockReset();
  hoisted.onAuthStateChange.mockReset().mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  hoisted.getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  hoisted.single.mockReset();
  hoisted.signOut.mockReset();
  hoisted.clearUserScopedLocalState.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("W0-B boot branch: session valid + profile missing", () => {
  it("sets needsProfile, keeps the session, and never signs out", async () => {
    hoisted.restoreSession.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: GOOGLE_USER }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116", status: 406 } });

    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));

    await waitFor(() => expect(capture.current?.needsProfile).not.toBeNull());
    expect(capture.current?.user).toBeNull();
    expect(capture.current?.needsProfile).toMatchObject({
      email: "new.person@example.com",
      name: "New Person",
      suggestedUsername: "new_person",
    });
    // Session KEPT: no sign-out issued, boot finished (not stuck, not looping).
    expect(hoisted.signOut).not.toHaveBeenCalled();
    expect(capture.current?.booting).toBe(false);
  });

  it("falls back to signed-out cleanup when there is no session behind the failure", async () => {
    hoisted.restoreSession.mockRejectedValue(new ApiError("Session expired", 401));
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));

    await waitFor(() => expect(capture.current?.booting).toBe(false));
    expect(capture.current?.user).toBeNull();
    expect(capture.current?.needsProfile).toBeNull();
  });

  it("does not route to completion when the profile row exists", async () => {
    hoisted.restoreSession.mockRejectedValue(new ApiError("transient", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: GOOGLE_USER }, error: null });
    hoisted.single.mockResolvedValue({ data: { id: "user-new" }, error: null });

    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));

    await waitFor(() => expect(capture.current?.booting).toBe(false));
    expect(capture.current?.needsProfile).toBeNull();
  });
});

describe("W0-B additive context members", () => {
  async function bootWithSeed(): Promise<{ current: Ctx | null }> {
    hoisted.restoreSession.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: GOOGLE_USER }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));
    await waitFor(() => expect(capture.current?.needsProfile).not.toBeNull());
    return capture;
  }

  it("clearNeedsProfile dismisses the completion state", async () => {
    const capture = await bootWithSeed();
    await act(async () => {
      capture.current!.clearNeedsProfile();
    });
    expect(capture.current!.needsProfile).toBeNull();
  });

  it("logout clears needsProfile and still runs account-switch cleanup", async () => {
    const capture = await bootWithSeed();
    await act(async () => {
      await capture.current!.logout();
    });
    expect(capture.current!.needsProfile).toBeNull();
    expect(capture.current!.user).toBeNull();
    expect(hoisted.clearUserScopedLocalState).toHaveBeenCalled();
  });

  it("signInWithGoogle fails closed with a human message while the S1 bridge is absent", async () => {    hoisted.restoreSession.mockResolvedValue({
      id: "u1",
      username: "tester",
      email: "t@example.com",
      phone: "01812345678",
      emailVerified: false,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies PublicUser);
    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe("u1"));

    const err = await capture.current!.signInWithGoogle("signin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not available/i);
    // Failed bridge attempt changes nothing.
    expect(capture.current!.user?.id).toBe("u1");
    expect(capture.current!.needsProfile).toBeNull();
  });
});

describe("W-E resolver hardening: external outcome adoption + repeat safety", () => {
  const AUTHENTICATED_USER = {
    id: "u1",
    username: "tester",
    email: "t@example.com",
    phone: "01812345678",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  } satisfies PublicUser;

  const NEEDS_PROFILE_SEED = {
    accountId: "user-new",
    email: "new.person@example.com",
    name: "New Person",
    avatarUrl: null,
    phone: "",
    suggestedUsername: "new_person",
  };

  it("adoptExternalAuthOutcome authenticated replaces a stale needsProfile seed (account switch safe)", async () => {
    hoisted.restoreSession.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: GOOGLE_USER }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));
    await waitFor(() => expect(capture.current?.needsProfile).not.toBeNull());

    await act(async () => {
      capture.current!.adoptExternalAuthOutcome({ status: "authenticated", user: AUTHENTICATED_USER });
    });
    expect(capture.current!.user).toEqual(AUTHENTICATED_USER);
    expect(capture.current!.needsProfile).toBeNull();
  });

  it("adoptExternalAuthOutcome needsProfile keeps the session and never signs out", async () => {
    hoisted.restoreSession.mockResolvedValue({ ...AUTHENTICATED_USER });
    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe("u1"));

    await act(async () => {
      capture.current!.adoptExternalAuthOutcome({ status: "needsProfile", seed: NEEDS_PROFILE_SEED });
    });
    expect(capture.current!.needsProfile).toEqual(NEEDS_PROFILE_SEED);
    // Existing session user is untouched until completion; no sign-out issued.
    expect(capture.current!.user?.id).toBe("u1");
    expect(hoisted.signOut).not.toHaveBeenCalled();
  });

  it("sign-out after a needsProfile state clears it and a repeat boot stays signed out", async () => {
    hoisted.restoreSession.mockRejectedValue(new ApiError("Could not load profile", 400));
    hoisted.getUser.mockResolvedValue({ data: { user: GOOGLE_USER }, error: null });
    hoisted.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const capture: { current: Ctx | null } = { current: null };
    render(harness(capture)({}));
    await waitFor(() => expect(capture.current?.needsProfile).not.toBeNull());

    await act(async () => {
      await capture.current!.logout();
    });
    expect(capture.current!.needsProfile).toBeNull();
    expect(capture.current!.user).toBeNull();
  });
});
