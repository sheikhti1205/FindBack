// @vitest-environment jsdom
/**
 * F08 — logout wipes the account's AI provider credentials by default.
 *
 * Exercises the AuthProvider `logout` callback (not the `services/auth`
 * Supabase wrapper): persisted + session keys for the signing-out account
 * are purged, a sibling account's keys are untouched, and a purge failure
 * still completes the logout (fail-closed toward signed-out).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";
import { clearUserScopedLocalState } from "./services/userScopedState";

const hoisted = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  restoreSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  beginAccountSwitch: vi.fn(),
  stopPush: vi.fn(async () => {}),
  fetchMe: vi.fn(() => new Promise(() => {})),
  authCallback: null as ((event: string, session: unknown) => void) | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  registerPlugin: vi.fn(),
}));

vi.mock("./services/auth", () => ({
  BootTimeoutError: class BootTimeoutError extends Error {},
  fetchMe: () => hoisted.fetchMe(),
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
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        hoisted.authCallback = cb;
        return hoisted.onAuthStateChange(cb);
      },
    },
  }),
}));

vi.mock("./services/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/session")>();
  return { ...actual, beginAccountSwitch: () => { hoisted.beginAccountSwitch(); actual.beginAccountSwitch(); } };
});

vi.mock("./services/realtime", () => ({
  connectRealtime: vi.fn(),
  disconnectRealtime: vi.fn(),
  joinInboxRoom: vi.fn(),
  leaveInboxRoom: vi.fn(),
}));

vi.mock("./services/pushRuntime", () => ({
  startPushNotifications: vi.fn(async () => {}),
  stopPushNotifications: () => hoisted.stopPush(),
}));

vi.mock("./services/userScopedState", () => ({
  clearUserScopedLocalState: vi.fn(),
}));

import { AuthProvider, useAuth } from "./auth";
import type { ComponentType, ReactNode } from "react";
import { aiCredentials } from "./services/aiCredentials";
import { AccountDeletionFeedback } from "./components/AccountDeletionFeedback";
import { RequireAuth } from "./components/Guards";
import { storage } from "./services/storage";

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

type AuthState = ReturnType<typeof useAuth>;
function probeHarness(capture: { current: { logout: () => Promise<void>; user: PublicUser | null } | null }) {
  const Probe: ComponentType = () => {
    const ctx = useAuth();
    capture.current = ctx;
    return null;
  };
  return function Harness({ children }: { children?: ReactNode }) {
    return (
      <AuthProvider>
        <Probe />
        {children}
      </AuthProvider>
    );
  };
}

beforeEach(() => {
  storage.removeItem("findback.auth.deletedAccountCleanup");
  hoisted.stopPush.mockResolvedValue(undefined);
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
  storage.removeItem("findback.auth.deletedAccountCleanup");
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

  it("signs out but reports credential cleanup failure instead of claiming keys removed", async () => {
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
      await expect(capture.current!.logout()).rejects.toThrow(/stored.*keys/i);
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

  it("keeps failed deletion cleanup visible through the real route guard and retries the captured account", async () => {
    const capture: { current: AuthState | null } = { current: null };
    const purge = vi.spyOn(aiCredentials, "removeAccountCredentials").mockRejectedValueOnce(new Error("vault down"));
    render(probeHarness(capture)({ children: <MemoryRouter initialEntries={["/account"]}><AccountDeletionFeedback /><Routes><Route path="/account" element={<RequireAuth><span>Protected account</span></RequireAuth>} /><Route path="/auth" element={<span>Sign in</span>} /></Routes></MemoryRouter> }));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    await act(async () => { await expect(capture.current!.finishAccountDeletion(USER_A.id)).rejects.toThrow(/stored/i); });
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Cleanup on this device did not finish");
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBe(USER_A.id);
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("stored AI keys were removed"));
    expect(hoisted.apiLogout).toHaveBeenLastCalledWith(USER_A.id);
    expect(purge).toHaveBeenLastCalledWith(USER_A.id);
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBeNull();
    purge.mockRestore();
  });

  it("retries persisted-auth removal too, without certifying a failed SDK cleanup", async () => {
    const capture: { current: AuthState | null } = { current: null };
    hoisted.apiLogout.mockRejectedValueOnce(new Error("session storage down"));
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    await act(async () => { await expect(capture.current!.finishAccountDeletion(USER_A.id)).rejects.toThrow(/stored/i); });
    expect(capture.current?.deletionCompletion?.state).toBe("cleanup-failed");
    await act(async () => { await capture.current!.retryDeletionCleanup(); });
    expect(hoisted.apiLogout).toHaveBeenCalledTimes(2);
    expect(hoisted.apiLogout).toHaveBeenLastCalledWith(USER_A.id);
    expect(capture.current?.deletionCompletion?.state).toBe("complete");
  });

  it("does not abandon A's keys when B is adopted during push teardown", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    let release!: () => void;
    hoisted.stopPush.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const purge = vi.spyOn(aiCredentials, "removeAccountCredentials");
    let finishing!: Promise<void>;
    await act(async () => { finishing = capture.current!.finishAccountDeletion(USER_A.id); });
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      hoisted.authCallback?.("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-b" });
      capture.current!.setUser({ ...USER_A, id: USER_B_ID }); release(); await finishing;
    });
    expect(purge).toHaveBeenCalledWith(USER_A.id);
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect(capture.current?.user?.id).toBe(USER_B_ID);
    expect(capture.current?.deletionCompletion).toBeNull();
    purge.mockRestore();
  });

  it("restores unfinished deletion cleanup after process restart", async () => {
    storage.setItem("findback.auth.deletedAccountCleanup", USER_A.id);
    hoisted.restoreSession.mockResolvedValue(null);
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({ children: <AccountDeletionFeedback /> }));
    await waitFor(() => expect(capture.current?.booting).toBe(false));
    expect(screen.getByRole("alert").textContent).toContain("Your account was permanently deleted");
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("complete"));
    expect(hoisted.apiLogout).toHaveBeenCalledWith(USER_A.id);
  });

  it("does not sign out or clear the account that replaced A mid-cleanup", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    let release!: () => void;
    const purge = vi.spyOn(aiCredentials, "removeAccountCredentials").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    let finishing!: Promise<void>;
    await act(async () => { finishing = capture.current!.finishAccountDeletion(USER_A.id); });
    await waitFor(() => expect(release).toBeDefined());
    // The SDK reports a different session holding the device slot.
    await act(async () => {
      hoisted.authCallback?.("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-b" });
      release();
      await finishing;
    });
    // The SDK owns B, whose profile is still loading. A must not remain
    // visible, be certified complete, or sign out B's persisted session.
    expect(capture.current?.deletionCompletion).toBeNull();
    expect(capture.current?.user).toBeNull();
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBeNull();
    purge.mockRestore();
  });

  it("clearing the completion also clears the persisted retry marker", async () => {
    storage.setItem("findback.auth.deletedAccountCleanup", USER_A.id);
    hoisted.restoreSession.mockResolvedValue(null);
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({ children: <AccountDeletionFeedback /> }));
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("cleanup-failed"));
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("complete"));
    act(() => capture.current!.dismissDeletionCompletion());
    expect(capture.current?.deletionCompletion).toBeNull();
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBeNull();
  });
});
