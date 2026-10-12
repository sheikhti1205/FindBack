// @vitest-environment jsdom
/**
 * F08 — logout wipes the account's AI provider credentials by default.
 *
 * Exercises the AuthProvider `logout` callback (not the `services/auth`
 * Supabase wrapper): persisted + session keys for the signing-out account
 * are purged, a sibling account's keys are untouched, and a purge failure
 * still completes the logout (fail-closed toward signed-out).
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";
import { clearUserScopedLocalState } from "./services/userScopedState";

const hoisted = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  restoreSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  beginAccountSwitch: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  registerPlugin: vi.fn(),
}));

vi.mock("./services/auth", () => ({
  BootTimeoutError: class BootTimeoutError extends Error {},
  fetchMe: vi.fn(),
  login: vi.fn(),
  logout: (...args: unknown[]) => hoisted.apiLogout(...args),
  register: vi.fn(),
  restoreSession: (...args: unknown[]) => hoisted.restoreSession(...args),
  sendPendingEmailCode: vi.fn(),
  verifyPendingEmailCode: vi.fn(),
}));

vi.mock("./services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      onAuthStateChange: (...args: unknown[]) => hoisted.onAuthStateChange(...args),
    },
  }),
}));

vi.mock("./services/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/session")>()),
  beginAccountSwitch: hoisted.beginAccountSwitch,
}));

vi.mock("./services/realtime", () => ({
  connectRealtime: vi.fn(),
  disconnectRealtime: vi.fn(),
  joinInboxRoom: vi.fn(),
  leaveInboxRoom: vi.fn(),
}));

vi.mock("./services/pushRuntime", () => ({
  startPushNotifications: vi.fn(async () => {}),
  stopPushNotifications: vi.fn(async () => {}),
}));

vi.mock("./services/userScopedState", () => ({
  clearUserScopedLocalState: vi.fn(),
}));

import { AuthProvider, useAuth } from "./auth";
import type { ComponentType, ReactNode } from "react";
import { aiCredentials } from "./services/aiCredentials";

const USER_A: PublicUser = {
  id: "f08-alice",
  username: "alice",
  email: "alice@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const USER_B_ID = "f08-bob";
const PHRASE = "f08 unlock phrase";
const ALICE_SAVED = "F08-ALICE-SAVED-KEY";
const ALICE_SESSION = "F08-ALICE-SESSION-KEY";
const BOB_SAVED = "F08-BOB-SAVED-KEY";

function probeHarness(capture: { current: { logout: () => Promise<void>; user: PublicUser | null } | null }) {
  const Probe: ComponentType = () => {
    const ctx = useAuth();
    capture.current = ctx;
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

beforeEach(() => {
  hoisted.apiLogout.mockResolvedValue(undefined);
  hoisted.restoreSession.mockResolvedValue({ ...USER_A });
  hoisted.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await aiCredentials.removeAccountCredentials(USER_A.id);
  await aiCredentials.removeAccountCredentials(USER_B_ID);
  aiCredentials.clearSession();
});

describe("F08 AuthProvider logout purges AI provider credentials", () => {
  it("purges the account's persisted + session keys and leaves the sibling's keys untouched", async () => {
    await aiCredentials.connect(USER_A.id, ALICE_SAVED, {
      remember: true,
      passphrase: PHRASE,
      provider: "openrouter",
    });
    await aiCredentials.connect(USER_A.id, ALICE_SESSION, { remember: false, provider: "anthropic" });
    await aiCredentials.connect(USER_B_ID, BOB_SAVED, {
      remember: true,
      passphrase: PHRASE,
      provider: "openrouter",
    });

    const capture: { current: { logout: () => Promise<void>; user: PublicUser | null } | null } = {
      current: null,
    };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));

    await act(async () => {
      await capture.current!.logout();
    });

    expect(await aiCredentials.get(USER_A.id, "openrouter")).toBeNull();
    expect(await aiCredentials.hasSaved(USER_A.id, "openrouter")).toBe(false);
    expect(await aiCredentials.get(USER_A.id, "anthropic")).toBeNull();
    expect(await aiCredentials.hasSaved(USER_A.id, "anthropic")).toBe(false);
    // The sibling's persisted slot survives (session entries are cleared for
    // everyone, so unlock proves the ciphertext is untouched).
    expect(await aiCredentials.hasSaved(USER_B_ID, "openrouter")).toBe(true);
    await aiCredentials.unlock(USER_B_ID, PHRASE, "openrouter");
    expect(await aiCredentials.get(USER_B_ID, "openrouter")).toBe(BOB_SAVED);
    expect(capture.current!.user).toBeNull();
  });

  it("still completes logout when the credential purge fails", async () => {
    await aiCredentials.connect(USER_A.id, ALICE_SESSION, { remember: false, provider: "openai" });
    const purge = vi
      .spyOn(aiCredentials, "removeAccountCredentials")
      .mockRejectedValueOnce(new Error("vault down"));

    const capture: { current: { logout: () => Promise<void>; user: PublicUser | null } | null } = {
      current: null,
    };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));

    await act(async () => {
      await capture.current!.logout();
    });

    expect(purge).toHaveBeenCalledWith(USER_A.id);
    expect(capture.current!.user).toBeNull();
    purge.mockRestore();
  });

  it("logout starts the account switch (beginAccountSwitch + user-scoped wipe)", async () => {
    const capture: { current: { logout: () => Promise<void>; user: PublicUser | null } | null } = {
      current: null,
    };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));

    await act(async () => {
      await capture.current!.logout();
    });

    expect(hoisted.beginAccountSwitch).toHaveBeenCalledTimes(1);
    expect(clearUserScopedLocalState).toHaveBeenCalled();
    expect(capture.current!.user).toBeNull();
  });
});
