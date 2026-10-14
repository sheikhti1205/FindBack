// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const seams = vi.hoisted(() => ({
  callback: undefined as ((event: string, session: unknown) => void) | undefined,
  fetchMe: vi.fn(), restoreSession: vi.fn(),
  login: vi.fn(), register: vi.fn(), seed: vi.fn(),
  resetAi: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" }, registerPlugin: vi.fn(),
}));
vi.mock("./services/supabaseClient", () => ({ getSupabase: () => ({ auth: {
  onAuthStateChange: (callback: typeof seams.callback) => {
    seams.callback = callback;
    return { data: { subscription: { unsubscribe: () => {} } } };
  },
} }) }));
vi.mock("./services/auth", () => ({
  BootTimeoutError: class BootTimeoutError extends Error {},
  restoreSession: () => seams.restoreSession(), fetchMe: (...args: unknown[]) => seams.fetchMe(...args),
  login: (...args: unknown[]) => seams.login(...args), logout: vi.fn(), register: (...args: unknown[]) => seams.register(...args), sendPendingEmailCode: vi.fn(), verifyPendingEmailCode: vi.fn(),
}));
vi.mock("./services/auth/googleSignIn", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/auth/googleSignIn")>(),
  getNeedsProfileSeed: (...args: unknown[]) => seams.seed(...args),
}));
vi.mock("./services/realtime", () => ({
  connectRealtime: vi.fn(), disconnectRealtime: vi.fn(), joinInboxRoom: vi.fn(), leaveInboxRoom: vi.fn(),
}));
vi.mock("./services/pushRuntime", () => ({ startPushNotifications: vi.fn(), stopPushNotifications: vi.fn() }));
// Inject the real service behind the singleton cleanup seam; preserve the
// actual AuthProvider -> userScopedState -> residency/reset production path.
vi.mock("./services/ai/applicationAi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/ai/applicationAi")>(),
  resetLocalAiForAccount: () => seams.resetAi?.(),
}));

import { AuthProvider, useAuth } from "./auth";
import { GuestOnly } from "./components/Guards";
import { ApplicationAiService } from "./services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR } from "./services/ai/modelDescriptors";
import { aiCredentials } from "./services/aiCredentials";
import { beginAccountSwitch, getPendingEmail, getToken, setPendingEmail } from "./services/session";
import { loadDraft, saveDraft } from "./services/reportDraft";
import { disconnectRealtime } from "./services/realtime";

const A: PublicUser = {
  id: "switch-a", username: "alice", email: "alice@example.invalid", phone: "", emailVerified: true,
  phoneVerified: false, avatarUrl: null, createdAt: "2026-01-01T00:00:00.000Z",
};
const B = { ...A, id: "switch-b", username: "bob" };
const C = { ...A, id: "switch-c", username: "carol" };
let auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return null; }
function event(account: PublicUser, kind = "SIGNED_IN") {
  seams.callback?.(kind, { user: { id: account.id }, access_token: `synthetic-${account.id}` });
}
function activeAi(unload = vi.fn(async () => {})) {
  let release!: () => void;
  let started = false;
  const disk = new Map<string, string>();
  const service = new ApplicationAiService({
    android: true,
    driver: {
      rootDir: async () => "/private/account-switch-test",
      freeBytes: async () => 2_000_000_000,
      stagedSize: async (path) => disk.has(path) ? 1 : 0,
      readJournalText: async () => null,
      download: async (attempt) => {
        disk.set(attempt.stagingPath, attempt.expectedSha256);
        return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
      },
      cancelDownload: async () => {},
      hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
      promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
      removeFile: async (path) => { disk.delete(path); },
    },
    needle: {
      bridgeName: "needle-cact", isNeedleAvailable: async () => true,
      embeddingDimension: async () => 2, loadModel: async () => 2,
      embedNeedleTexts: async () => [[1, 0]], initTools: async () => {}, unload,
      completeJson: async () => {
        started = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "Red umbrella" } }] });
      },
    },
    smol: {
      bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
      loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {},
      describeImage: async function* () {}, collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
    },
  });
  seams.resetAi = () => service.resetForAccount();
  return { service, unload, started: () => started, release: () => release() };
}

beforeEach(() => {
  seams.restoreSession.mockResolvedValue(A);
  seams.fetchMe.mockImplementation(() => new Promise(() => {}));
  seams.seed.mockResolvedValue(null);
});
afterEach(() => {
  cleanup(); vi.clearAllMocks(); aiCredentials.clearSession(); seams.resetAi = undefined; setPendingEmail(null);
});

describe("direct SDK account replacement isolation", () => {
  it("cancels A's real local flight and clears private state before B's profile resolves", async () => {
    const local = activeAi();
    await local.service.ready;
    const id = NEEDLE_DESCRIPTOR.modelId;
    await local.service.download(id);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    saveDraft({ type: "LOST", title: "A private draft", description: "", category: "", eventDate: "", location: { label: "", latitude: null, longitude: null }, youtubeUrl: "" }, A.id);
    await aiCredentials.connect(A.id, "synthetic-session-key", { remember: false, provider: "openrouter" });
    setPendingEmail("a@example.invalid");
    const result = local.service.route("extract-report-fields", { prompt: "A lost an umbrella" }, { traceId: "auth-switch-flight" });
    await waitFor(() => expect(local.started()).toBe(true));
    try {
      await act(async () => { event(B); });
      expect(auth.user).toBeNull();
      expect(loadDraft(A.id)).toBeNull();
      expect(await aiCredentials.get(A.id, "openrouter")).toBeNull();
      expect(getToken()).toBe("synthetic-switch-b");
      expect(getPendingEmail()).toBeNull();
      expect(disconnectRealtime).toHaveBeenCalled();
      const cancelled = await result;
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.denialReason).toBe("CANCELLED");
      expect(local.unload).not.toHaveBeenCalled(); // Busy native work is never torn down.
    } finally { local.release(); }
    await waitFor(() => expect(local.unload).toHaveBeenCalled());
    expect(local.service.manager.statusOf(id)?.download).toBe("installed");
  });

  it("keeps the current account's credentials across same-account refresh events", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await aiCredentials.connect(A.id, "synthetic-session-key", { remember: false, provider: "openrouter" });
    const reset = vi.fn(async () => {});
    seams.resetAi = reset;
    await act(async () => { event(A, "TOKEN_REFRESHED"); event(A); });
    expect(reset).not.toHaveBeenCalled();
    expect(auth.user?.id).toBe(A.id);
    expect(await aiCredentials.get(A.id, "openrouter")).toBe("synthetic-session-key");
  });

  it("drops a late B profile after the SDK slot has already changed to C", async () => {
    let resolveB!: (user: PublicUser) => void;
    seams.fetchMe.mockImplementation((id: string) => id === B.id ? new Promise<PublicUser>((resolve) => { resolveB = resolve; }) : Promise.resolve(C));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(B); });
    await waitFor(() => expect(resolveB).toBeDefined());
    await act(async () => { event(C); });
    await waitFor(() => expect(auth.user?.id).toBe(C.id));
    await act(async () => { resolveB(B); });
    expect(auth.user?.id).toBe(C.id);
    expect(getToken()).toBe("synthetic-switch-c");
  });

  it("does not restore A from a manual refresh that settles after switching to B", async () => {
    let resolveA!: (user: PublicUser) => void;
    seams.fetchMe.mockImplementation((id?: string) => id === B.id ? Promise.resolve(B) : new Promise<PublicUser>((resolve) => { resolveA = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    const refresh = auth.refreshUser();
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    await act(async () => { resolveA(A); await refresh; });
    expect(auth.user?.id).toBe(B.id);
  });

  it("does not clear B's session when an old boot restore fails late", async () => {
    let rejectBoot!: (error: Error) => void;
    seams.restoreSession.mockImplementation(() => new Promise<PublicUser>((_resolve, reject) => { rejectBoot = reject; }));
    seams.fetchMe.mockResolvedValue(B);
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    await act(async () => { rejectBoot(new Error("Old account's restore failed")); });
    expect(auth.user?.id).toBe(B.id);
    expect(getToken()).toBe("synthetic-switch-b");
  });

  it("restores the startup profile when INITIAL_SESSION arrives before boot finishes", async () => {
    let resolveBoot!: (user: PublicUser) => void;
    seams.restoreSession.mockImplementation(() => new Promise<PublicUser>((resolve) => { resolveBoot = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { event(A, "INITIAL_SESSION"); resolveBoot(A); });
    expect(auth.user?.id).toBe(A.id);
    expect(getToken()).toBe("synthetic-switch-a");
  });

  it("does not resurrect A when a refresh finishes after local sign-out notification", async () => {
    let resolveA!: (user: PublicUser) => void;
    seams.fetchMe.mockImplementation(() => new Promise<PublicUser>((resolve) => { resolveA = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    const refresh = auth.refreshUser();
    await act(async () => { beginAccountSwitch(); });
    await act(async () => { resolveA(A); await refresh; });
    expect(auth.user).toBeNull();
  });

  it("rejects A's late password-login profile after B takes the SDK slot", async () => {
    let resolveLogin!: (user: PublicUser) => void;
    seams.login.mockImplementation(() => new Promise<PublicUser>((resolve) => { resolveLogin = resolve; }));
    seams.fetchMe.mockResolvedValue(B);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    const login = auth.login("alice@example.invalid", "synthetic-password");
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    await act(async () => { resolveLogin(A); await expect(login).rejects.toThrow(/account changed/i); });
    expect(auth.user?.id).toBe(B.id);
  });

  it.each(["completion", "external"])("rejects late A %s adoption after B takes the SDK slot", async (publisher) => {
    seams.fetchMe.mockResolvedValue(B);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    expect(() => publisher === "completion" ? auth.setUser(A) : auth.adoptExternalAuthOutcome({ status: "authenticated", user: A })).toThrow(/account changed/i);
    expect(auth.user?.id).toBe(B.id);
  });

  it("rejects a boot profile that disagrees with the initial SDK snapshot", async () => {
    let resolveBoot!: (user: PublicUser) => void;
    seams.restoreSession.mockImplementation(() => new Promise<PublicUser>((resolve) => { resolveBoot = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { event(B, "INITIAL_SESSION"); resolveBoot(A); });
    expect(auth.user).toBeNull();
    expect(getToken()).toBe("synthetic-switch-b");
  });

  it("routes a valid replacement session without a profile to its own completion seed", async () => {
    const seed = { accountId: B.id, email: B.email, name: null, avatarUrl: null, phone: "", suggestedUsername: "bob" };
    seams.fetchMe.mockRejectedValue(new Error("Profile missing"));
    seams.seed.mockResolvedValue(seed);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.needsProfile).toEqual(seed));
    expect(auth.user).toBeNull();
    expect(getToken()).toBe("synthetic-switch-b");
  });

  it("coalesces real AI cleanup across rapid B -> C replacements without opening its barrier early", async () => {
    const releases: Array<() => void> = [];
    const unload = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const local = activeAi(unload);
    await local.service.ready;
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(B); });
    await waitFor(() => expect(unload).toHaveBeenCalled());
    await act(async () => { event(C); });
    try {
      await expect(local.service.route("extract-report-fields", { prompt: "C" }, { traceId: "reset-barrier" })).rejects.toThrow(/busy/i);
      expect(unload).toHaveBeenCalledTimes(1);
    } finally { releases.forEach((release) => release()); }
    await waitFor(async () => expect(await local.service.route("extract-report-fields", { prompt: "C" }, { traceId: "reset-done" })).toMatchObject({ ok: false, denialReason: "NO_RUNTIME" }));
  });

  it("rejects a late A login after local sign-out even before the SDK emits SIGNED_OUT", async () => {
    let resolveLogin!: (user: PublicUser) => void;
    seams.login.mockImplementation(() => new Promise<PublicUser>((resolve) => { resolveLogin = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(A); });
    const login = auth.login(A.email, "synthetic-password");
    await act(async () => { beginAccountSwitch(); });
    await act(async () => { resolveLogin(A); await expect(login).rejects.toThrow(/account changed/i); });
    expect(auth.user).toBeNull();
    expect(getToken()).toBeNull();
    expect(() => auth.setUser(A)).toThrow(/account changed/i);
  });

  it("preserves B after an INITIAL_SESSION profile succeeds but its overlapping boot fails", async () => {
    let rejectBoot!: (error: Error) => void;
    seams.restoreSession.mockImplementation(() => new Promise<PublicUser>((_resolve, reject) => { rejectBoot = reject; }));
    seams.fetchMe.mockResolvedValue(B);
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { event(B, "INITIAL_SESSION"); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    await act(async () => { rejectBoot(new Error("Overlapping boot failed")); });
    expect(auth.user?.id).toBe(B.id);
    expect(getToken()).toBe("synthetic-switch-b");
    expect(auth.bootError).toBeNull();
  });

  it.each(["TOKEN_REFRESHED", "SIGNED_IN"])("does not recache A on %s during local sign-out, but accepts a new B sign-in", async (kind) => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    await act(async () => { event(A); beginAccountSwitch(); event(A, kind); });
    expect(auth.user).toBeNull();
    expect(getToken()).toBeNull();
    seams.fetchMe.mockResolvedValue(B);
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    expect(getToken()).toBe("synthetic-switch-b");
  });

  it.each(["early", "late"])("resumes B's incomplete profile when the old boot seed probe returns null %s", async (order) => {
    let rejectBoot!: (error: Error) => void;
    let rejectProfile!: (error: Error) => void;
    let resolveOldSeed!: (seed: null) => void;
    const seed = { accountId: B.id, email: B.email, name: null, avatarUrl: null, phone: "", suggestedUsername: "bob" };
    seams.restoreSession.mockImplementation(() => new Promise<PublicUser>((_resolve, reject) => { rejectBoot = reject; }));
    seams.fetchMe.mockImplementation(() => new Promise<PublicUser>((_resolve, reject) => { rejectProfile = reject; }));
    seams.seed.mockImplementationOnce(() => new Promise((resolve) => { resolveOldSeed = resolve; })).mockResolvedValue(seed);
    render(<AuthProvider><Probe /><MemoryRouter initialEntries={["/auth"]}><Routes>
      <Route path="/auth" element={<GuestOnly><span>Sign in</span></GuestOnly>} />
      <Route path="/complete-profile" element={<span>Resume B profile</span>} />
    </Routes></MemoryRouter></AuthProvider>);
    await act(async () => { event(B, "INITIAL_SESSION"); });
    await waitFor(() => expect(rejectProfile).toBeDefined());
    await act(async () => { rejectBoot(new Error("Boot lookup unavailable")); });
    await waitFor(() => expect(resolveOldSeed).toBeDefined());
    if (order === "early") {
      await act(async () => { resolveOldSeed(null); });
      await waitFor(() => expect(auth.bootError).toBe("unreachable"));
    }
    await act(async () => { rejectProfile(new Error("Profile missing")); });
    await waitFor(() => expect(auth.needsProfile).toEqual(seed));
    if (order === "late") await act(async () => { resolveOldSeed(null); });
    await waitFor(() => expect(screen.getByText("Resume B profile")).toBeTruthy());
    expect(auth.needsProfile).toEqual(seed);
    expect(auth.bootError).toBeNull();
    expect(getToken()).toBe("synthetic-switch-b");
  });

  it("does not publish A's late pending-registration email into B's account", async () => {
    let resolveRegistration!: (value: unknown) => void;
    seams.register.mockImplementation(() => new Promise((resolve) => { resolveRegistration = resolve; }));
    seams.fetchMe.mockResolvedValue(B);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(auth.user?.id).toBe(A.id));
    const registration = auth.register({ username: "alice", email: "a@example.invalid", phone: "", password: "synthetic-password" });
    await act(async () => { event(B); });
    await waitFor(() => expect(auth.user?.id).toBe(B.id));
    await act(async () => {
      resolveRegistration({ user: A, emailVerificationRequired: true, email: "a@example.invalid" });
      await expect(registration).rejects.toThrow(/account changed/i);
    });
    expect(auth.pendingEmail).toBeNull();
    expect(getPendingEmail()).toBeNull();
    expect(auth.user?.id).toBe(B.id);
  });

  it("allows another real reset queued by cleanup completion without leaving the barrier stuck", async () => {
    const local = activeAi();
    await local.service.ready;
    let second!: Promise<void>;
    let queued = false;
    const unsubscribe = local.service.subscribe(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { second = local.service.resetForAccount(); });
    });
    try {
      await local.service.resetForAccount();
      await second;
      await expect(local.service.route("extract-report-fields", { prompt: "C" }, { traceId: "reset-completion-window" })).resolves.toMatchObject({ ok: false, denialReason: "NO_RUNTIME" });
    } finally { unsubscribe(); }
  });
});
