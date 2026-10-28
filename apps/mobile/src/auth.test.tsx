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
import { IDBFactory } from "fake-indexeddb";
import { locks } from "node:worker_threads";
import * as deletionRegistry from "./services/messaging/scopedMediaBytes";
import * as messagingRuntime from "./services/messaging/runtime";
import { openPlatformMessagingHistory } from "./services/messaging/platformHistory";
import { openMediaBytes } from "./services/messaging/mediaBytes";

const hoisted = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  restoreSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  beginAccountSwitch: vi.fn(),
  stopPush: vi.fn(async () => {}),
  startPush: vi.fn(async (_owner: { accountId: string; isCurrent: () => boolean }) => {}),
  fetchMe: vi.fn(() => new Promise(() => {})),
  authCallback: null as ((event: string, session: unknown) => void) | null,
  storedSession: false,
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
  hasStoredAuthSession: () => hoisted.storedSession,
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
  startPushNotifications: (owner: { accountId: string; isCurrent: () => boolean }) => hoisted.startPush(owner),
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
import { ApiError } from "./services/session";
import { clearSessionExpired, sessionExpiredPending } from "./services/sessionExpiry";

const USER_A: PublicUser = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "alice",
  email: "alice@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const USER_B_ID = "00000000-0000-4000-8000-000000000002";
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
  vi.stubGlobal("indexedDB", new IDBFactory());
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  hoisted.storedSession = false;
  clearSessionExpired();
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await aiCredentials.removeAccountCredentials(USER_A.id);
  await aiCredentials.removeAccountCredentials(USER_B_ID);
  aiCredentials.clearSession();
  storage.removeItem("findback.auth.deletedAccountCleanup");
  vi.unstubAllGlobals();
});

describe("F08 AuthProvider logout purges AI provider credentials", () => {
  it("passes a live account guard to push, invalidated synchronously by the SDK", async () => {
    hoisted.startPush.mockClear();
    const capture = { current: null } as Parameters<typeof probeHarness>[0];
    const Harness = probeHarness(capture);
    render(<Harness />);
    await waitFor(() => expect(hoisted.startPush).toHaveBeenCalled());
    const owner = hoisted.startPush.mock.calls.at(-1)![0];
    expect(owner.accountId).toBe(USER_A.id);
    expect(owner.isCurrent()).toBe(true);
    act(() => hoisted.authCallback!("SIGNED_OUT", null));
    expect(owner.isCurrent()).toBe(false);
  });
  it("persists a real boot expiry but not a cold guest launch", async () => {
    hoisted.storedSession = true;
    hoisted.restoreSession.mockRejectedValue(new ApiError("Session expired", 401));
    const capture = { current: null } as Parameters<typeof probeHarness>[0];
    const Harness = probeHarness(capture);
    const first = render(<Harness />);
    await waitFor(() => expect(sessionExpiredPending()).toBe(true));
    first.unmount();
    clearSessionExpired();
    hoisted.storedSession = false;
    render(<Harness />);
    await waitFor(() => expect(hoisted.restoreSession).toHaveBeenCalledTimes(2));
    expect(sessionExpiredPending()).toBe(false);
  });

  it("records an unexpected SDK sign-out, then clears the reason on sign-in", async () => {
    const capture = { current: null } as Parameters<typeof probeHarness>[0];
    const Harness = probeHarness(capture);
    render(<Harness />);
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    act(() => hoisted.authCallback!("SIGNED_OUT", null));
    expect(sessionExpiredPending()).toBe(true);
    act(() => hoisted.authCallback!("SIGNED_IN", { user: { id: USER_A.id }, access_token: "test-only" }));
    expect(sessionExpiredPending()).toBe(false);
  });

  it("does not call an ordinary user-requested sign-out an expiry", async () => {
    const capture = { current: null } as Parameters<typeof probeHarness>[0];
    const Harness = probeHarness(capture);
    render(<Harness />);
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    hoisted.apiLogout.mockImplementationOnce(async () => { hoisted.authCallback!("SIGNED_OUT", null); });
    await act(async () => { await capture.current!.logout(); });
    expect(sessionExpiredPending()).toBe(false);
  });

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
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: true, messagingPending: false }),
    ]);
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

  it("migrates legacy unfinished deletion cleanup and automatically retries after restart", async () => {
    storage.setItem("findback.auth.deletedAccountCleanup", USER_A.id);
    hoisted.restoreSession.mockResolvedValue(null);
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({ children: <AccountDeletionFeedback /> }));
    await waitFor(() => expect(capture.current?.booting).toBe(false));
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("complete"));
    expect(hoisted.apiLogout).toHaveBeenCalledWith(USER_A.id);
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBeNull();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
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

  it("dismissing failed feedback never cancels durable cleanup, including after restart", async () => {
    storage.setItem("findback.auth.deletedAccountCleanup", USER_A.id);
    hoisted.restoreSession.mockResolvedValue(null);
    const purge = vi.spyOn(aiCredentials, "removeAccountCredentials").mockRejectedValue(new Error("vault down"));
    const capture: { current: AuthState | null } = { current: null };
    const Harness = probeHarness(capture);
    const first = render(<Harness><AccountDeletionFeedback /></Harness>);
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("cleanup-failed"));
    act(() => capture.current!.dismissDeletionCompletion());
    expect(capture.current?.deletionCompletion).toBeNull();
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBeNull();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: true, messagingPending: false }),
    ]);
    first.unmount();
    purge.mockRestore();
    render(<Harness><AccountDeletionFeedback /></Harness>);
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("complete"));
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
  });

  it("cleans confirmed captured A even if B replaced it before admission", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials");
    await act(async () => {
      hoisted.authCallback!("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-test-only-b" });
      capture.current!.setUser({ ...USER_A, id: USER_B_ID });
      await capture.current!.finishAccountDeletion(USER_A.id);
    });
    expect(keys).toHaveBeenCalledWith(USER_A.id);
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect(capture.current?.user?.id).toBe(USER_B_ID);
    expect(capture.current?.deletionCompletion).toBeNull();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    await expect(deletionRegistry.assertMessagingAccountActive(USER_A.id)).rejects.toThrow(/deleted/i);
    await deletionRegistry.assertMessagingAccountActive(USER_B_ID);
  });

  it("does not forget failed media cleanup when key/session work succeeds", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    vi.spyOn(messagingRuntime, "purgeMessagingAccount").mockRejectedValueOnce(new Error("bytes down"));
    await act(async () => { await expect(capture.current!.finishAccountDeletion(USER_A.id)).rejects.toThrow(); });
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: false, messagingPending: true }),
    ]);
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials");
    await act(async () => { await capture.current!.retryDeletionCleanup(); });
    expect(keys).not.toHaveBeenCalled();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    expect(capture.current?.deletionCompletion?.state).toBe("complete");
  });

  it("discovers all durable pending accounts without a scalar marker and leaves replacement B signed in", async () => {
    const C = "00000000-0000-4000-8000-000000000003";
    await deletionRegistry.beginConfirmedAccountDeletion(USER_A.id);
    await deletionRegistry.beginConfirmedAccountDeletion(C);
    hoisted.restoreSession.mockResolvedValue({ ...USER_A, id: USER_B_ID });
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials");
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({ children: <AccountDeletionFeedback /> }));
    await waitFor(async () => expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]));
    expect(keys).toHaveBeenCalledWith(USER_A.id);
    expect(keys).toHaveBeenCalledWith(C);
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect(capture.current?.user?.id).toBe(USER_B_ID);
    expect(screen.queryByRole("region", { name: "Account deletion" })).toBeNull();
  });

  it("retains a legacy hint when durable migration fails and retries only after admission works", async () => {
    storage.setItem("findback.auth.deletedAccountCleanup", USER_A.id);
    hoisted.restoreSession.mockResolvedValue(null);
    const admit = vi.spyOn(deletionRegistry, "beginConfirmedAccountDeletion").mockRejectedValue(new Error("IDB down"));
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials");
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({ children: <AccountDeletionFeedback /> }));
    await waitFor(() => expect(admit).toHaveBeenCalledWith(USER_A.id));
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBe(USER_A.id);
    expect(keys).not.toHaveBeenCalled();
    expect(capture.current?.deletionCompletion?.state).not.toBe("complete");
    admit.mockRestore();
    await act(async () => { await capture.current!.retryDeletionCleanup(); });
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    expect(capture.current?.deletionCompletion?.state).toBe("complete");
  });

  it("ordinary logout does not admit or purge messaging history", async () => {
    const purge = vi.spyOn(messagingRuntime, "purgeMessagingAccount");
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    await act(async () => { await capture.current!.logout(); });
    expect(purge).not.toHaveBeenCalled();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    await deletionRegistry.assertMessagingAccountActive(USER_A.id);
  });

  it("retains actual local messages/outbox on logout, then erases only confirmed A's history", async () => {
    const deviceId = "00000000-0000-4000-8000-000000000099";
    const conversationId = "00000000-0000-4000-8000-000000000010";
    const message = { id: "00000000-0000-4000-8000-000000000011", conversationId,
      authorId: USER_A.id, recipientId: USER_B_ID, body: "Synthetic test-only local message" };
    const a = await openPlatformMessagingHistory({ accountId: USER_A.id, deviceId });
    const b = await openPlatformMessagingHistory({ accountId: USER_B_ID, deviceId });
    const owner = { platform: "web" as const, accountId: USER_A.id, deviceId, backendUrl: "https://synthetic-backend.example.test" };
    const aBytes = await deletionRegistry.openScopedMediaBytes(owner);
    const bBytes = await deletionRegistry.openScopedMediaBytes({ ...owner, accountId: USER_B_ID });
    const attachmentId = "00000000-0000-4000-8000-000000000088", payload = new Uint8Array([1, 2, 3]).buffer;
    try {
      await a.history.enqueueOutgoing(message);
      await b.history.enqueueOutgoing({ ...message, authorId: USER_B_ID, recipientId: USER_A.id });
      await aBytes.put(USER_A.id, attachmentId, payload);
      await bBytes.put(USER_B_ID, attachmentId, payload);
      const capture: { current: AuthState | null } = { current: null };
      render(probeHarness(capture)({}));
      await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
      await act(async () => { await capture.current!.logout(); });
      expect(await a.history.listMessages(conversationId)).toHaveLength(1);
      expect(await a.history.listOutbox()).toHaveLength(1);
      expect(await aBytes.get(USER_A.id, attachmentId)).toEqual(payload);
      await a.close();
      await act(async () => {
        hoisted.authCallback!("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-test-only-b" });
        capture.current!.setUser({ ...USER_A, id: USER_B_ID });
        await capture.current!.finishAccountDeletion(USER_A.id);
      });
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(`findback-human-history-v1:${USER_A.id}:${deviceId}`);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        for (const store of ["messages", "outbox"]) {
          const count = await new Promise<number>((resolve) => {
            const request = db.transaction(store).objectStore(store).count();
            request.onsuccess = () => resolve(request.result);
          });
          expect(count).toBe(0);
        }
      } finally { db.close(); }
      expect(await b.history.listMessages(conversationId)).toHaveLength(1);
      expect(await b.history.listOutbox()).toHaveLength(1);
      const raw = await openMediaBytes({ databaseName: `findback-chat-media-bytes-v1:${JSON.stringify(["web", USER_A.id, deviceId, owner.backendUrl])}` });
      try { expect(await raw.totalBytes(USER_A.id)).toBe(0); expect(await raw.keys(USER_A.id)).toEqual([]); }
      finally { await raw.close(); }
      expect(await bBytes.get(USER_B_ID, attachmentId)).toEqual(payload);
      expect(capture.current?.user?.id).toBe(USER_B_ID);
    } finally { await a.close(); await b.close(); await aBytes.close(); await bBytes.close(); }
  });

  it("does not suppress B's unexpected sign-out while cleaning delayed A credentials", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    let release!: () => void;
    vi.spyOn(aiCredentials, "removeAccountCredentials").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => {
      hoisted.authCallback!("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-test-only-b" });
      capture.current!.setUser({ ...USER_A, id: USER_B_ID });
    });
    let work!: Promise<void>;
    await act(async () => { work = capture.current!.finishAccountDeletion(USER_A.id); });
    await waitFor(() => expect(release).toBeDefined());
    try {
      act(() => { hoisted.authCallback!("SIGNED_OUT", null); });
      expect(sessionExpiredPending()).toBe(true);
    } finally { await act(async () => { release(); await work; }); }
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect(sessionExpiredPending()).toBe(true);
  });

  it("retains separately failed A keys and B messages, then recovers both after restart", async () => {
    const remove = aiCredentials.removeAccountCredentials.bind(aiCredentials);
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials").mockImplementation(async (accountId) => {
      if (accountId === USER_A.id) throw new Error("A vault down");
      await remove(accountId);
    });
    const purgeAccount = messagingRuntime.purgeMessagingAccount;
    const media = vi.spyOn(messagingRuntime, "purgeMessagingAccount").mockImplementation(async (accountId) => {
      if (accountId === USER_B_ID) throw new Error("B bytes down");
      await purgeAccount(accountId);
    });
    const capture: { current: AuthState | null } = { current: null };
    const Harness = probeHarness(capture), first = render(<Harness />);
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    await act(async () => { await expect(capture.current!.finishAccountDeletion(USER_A.id)).rejects.toThrow(); });
    await act(async () => {
      hoisted.authCallback!("SIGNED_IN", { user: { id: USER_B_ID }, access_token: "synthetic-test-only-b" });
      capture.current!.setUser({ ...USER_A, id: USER_B_ID });
      await expect(capture.current!.finishAccountDeletion(USER_B_ID)).rejects.toThrow();
    });
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: true, messagingPending: false }),
      expect.objectContaining({ accountId: USER_B_ID, authPending: false, messagingPending: true }),
    ]);
    first.unmount(); keys.mockRestore(); media.mockRestore();
    hoisted.restoreSession.mockResolvedValue(null);
    render(<Harness />);
    await waitFor(async () => expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]));
    await waitFor(() => expect(capture.current?.deletionCompletion?.state).toBe("complete"));
  });

  it("keeps fresh confirmed deletion retryable when durable admission itself fails", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    const admit = vi.spyOn(deletionRegistry, "beginConfirmedAccountDeletion").mockRejectedValue(new Error("registry down"));
    const keys = vi.spyOn(aiCredentials, "removeAccountCredentials");
    await act(async () => { await expect(capture.current!.finishAccountDeletion(USER_A.id)).rejects.toThrow(/registry down/); });
    expect(keys).not.toHaveBeenCalled();
    expect(capture.current?.deletionCompletion?.state).toBe("cleanup-failed");
    expect(storage.getItem("findback.auth.deletedAccountCleanup")).toBe(USER_A.id);
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    admit.mockRestore();
    await act(async () => { await capture.current!.retryDeletionCleanup(); });
    expect(capture.current?.deletionCompletion?.state).toBe("complete");
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
  });

  it("does not let an overlapping older deletion acknowledge the newer failed auth work", async () => {
    const capture: { current: AuthState | null } = { current: null };
    render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    let release!: () => void;
    const remove = vi.spyOn(aiCredentials, "removeAccountCredentials")
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("newer vault cleanup failed"));
    let first!: Promise<unknown>, second!: Promise<unknown>;
    await act(async () => { first = capture.current!.finishAccountDeletion(USER_A.id).catch((error: unknown) => error); });
    await waitFor(() => expect(release).toBeDefined());
    const [older] = (await deletionRegistry.inspectPendingAccountDeletions()).pending;
    await act(async () => { second = capture.current!.finishAccountDeletion(USER_A.id).catch((error: unknown) => error); });
    try {
      await waitFor(async () => {
        const [newer] = (await deletionRegistry.inspectPendingAccountDeletions()).pending;
        expect(newer!.authRevision).toBeGreaterThan(older!.authRevision);
      });
    } finally { await act(async () => { release(); await Promise.all([first, second]); }); }
    expect(await first).toBeInstanceOf(AggregateError);
    expect(await second).toBeInstanceOf(AggregateError);
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: true, messagingPending: false }),
    ]);
    expect(capture.current?.deletionCompletion?.state).toBe("cleanup-failed");
    remove.mockRestore();
    await act(async () => { await capture.current!.retryDeletionCleanup(); });
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([]);
    expect(capture.current?.deletionCompletion?.state).toBe("complete");
  });

  it("retains pending auth work if the auth owner unmounts during key cleanup", async () => {
    const capture: { current: AuthState | null } = { current: null };
    const first = render(probeHarness(capture)({}));
    await waitFor(() => expect(capture.current?.user?.id).toBe(USER_A.id));
    let release!: () => void;
    vi.spyOn(aiCredentials, "removeAccountCredentials").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    let outcome!: Promise<unknown>;
    await act(async () => { outcome = capture.current!.finishAccountDeletion(USER_A.id).catch((error: unknown) => error); });
    await waitFor(() => expect(release).toBeDefined());
    first.unmount();
    release();
    expect(await outcome).toBeInstanceOf(AggregateError);
    expect(hoisted.apiLogout).not.toHaveBeenCalled();
    expect((await deletionRegistry.inspectPendingAccountDeletions()).pending).toEqual([
      expect.objectContaining({ accountId: USER_A.id, authPending: true, messagingPending: false }),
    ]);
  });
});
