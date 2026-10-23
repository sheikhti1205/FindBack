// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: null as {
    id: string;
    username: string;
    email: string;
    phone: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    avatarUrl: string | null;
    createdAt: string;
  } | null,
  booting: false,
  bootError: null as string | null,
  retryBoot: vi.fn(),
}));
const native = vi.hoisted(() => ({ back: null as (() => void) | null }));
const editorPosts = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("./services/posts", async (original) => ({
  ...await original<typeof import("./services/posts")>(),
  fetchPost: editorPosts.load,
  updatePost: editorPosts.save,
}));
vi.mock("./auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ ...auth }),
}));
vi.mock("./theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/app", () => ({
  App: {
    getLaunchUrl: async () => undefined,
    addListener: (event: string, listener: () => void) => {
      if (event !== "backButton") return Promise.resolve({ remove: () => {} });
      native.back = listener;
      return Promise.resolve({ remove: () => { native.back = null; } });
    },
  },
}));
vi.mock("./screens/Onboarding", () => ({
  Onboarding: () => <p>Onboarding screen</p>,
  ONBOARDING_PAGES: [],
}));
vi.mock("./screens/AuthGateway", () => ({
  AuthGateway: ({ initialMode = "email" }: { initialMode?: string }) => (
    <p>Gateway:{initialMode}</p>
  ),
}));
const marker = vi.hoisted(() => (name: string) => () => <p>{name} screen</p>);
vi.mock("./screens/Verify", () => ({ Verify: () => <p>Verify screen</p> }));
vi.mock("./screens/ForgotPassword", () => ({ ForgotPassword: () => <p>ForgotPassword screen</p> }));
vi.mock("./screens/Recovery", () => ({ Recovery: () => <p>Recovery screen</p> }));
vi.mock("./screens/Home", () => ({ Home: () => <p>Home screen</p> }));
vi.mock("./screens/SearchScreen", () => ({ SearchScreen: () => <p>Search screen</p> }));
vi.mock("./screens/CreateReport", () => ({ CreateReport: () => <p>CreateReport screen</p> }));
vi.mock("./screens/PostDetail", () => ({ PostDetail: () => <p>PostDetail screen</p> }));
vi.mock("./screens/Profile", () => ({ Profile: () => <p>Profile screen</p> }));
vi.mock("./screens/ProfileEdit", () => ({ ProfileEdit: () => <p>ProfileEdit screen</p> }));
vi.mock("./screens/About", () => ({ About: () => <p>About screen</p> }));
vi.mock("./screens/MyPosts", () => ({ MyPosts: () => <p>MyPosts screen</p> }));
vi.mock("./screens/Help", () => ({ Help: () => <p>Help screen</p> }));
vi.mock("./screens/AiConnection", () => ({ AiConnection: () => <p>AiConnection screen</p> }));
vi.mock("./screens/AiModelsRoute", () => ({ AiModelsRoute: () => <p>AiModelsRoute screen</p> }));
vi.mock("./screens/LocalIntelligence", () => ({ LocalIntelligence: () => <p>LocalIntelligence screen</p> }));
vi.mock("./screens/DownloadedModels", () => ({ DownloadedModels: () => <p>DownloadedModels screen</p> }));
vi.mock("./screens/Notifications", () => ({ Notifications: () => <p>Notifications screen</p> }));
vi.mock("./screens/SharedReport", () => ({ SharedReport: () => <p>SharedReport screen</p> }));
vi.mock("./screens/Settings", () => ({ Settings: marker("Settings") }));
vi.mock("./screens/AdminBootstrap", () => ({ AdminBootstrap: marker("AdminBootstrap") }));
vi.mock("./screens/BlockedUsers", () => ({ BlockedUsers: marker("BlockedUsers") }));
vi.mock("./screens/SafetyReports", () => ({ SafetyReports: marker("SafetyReports") }));
vi.mock("./screens/FeedbackForm", () => ({ FeedbackForm: marker("FeedbackForm") }));
vi.mock("./screens/Returns", () => ({ Returns: marker("Returns") }));
vi.mock("./screens/AccountSettings", () => ({ AccountSettings: marker("AccountSettings") }));
vi.mock("./screens/AppearanceSettings", () => ({ AppearanceSettings: marker("AppearanceSettings") }));
vi.mock("./screens/AccessibilitySettings", () => ({ AccessibilitySettings: marker("AccessibilitySettings") }));
vi.mock("./screens/FeedLayoutSettings", () => ({ FeedLayoutSettings: marker("FeedLayoutSettings") }));
vi.mock("./screens/MediaSettings", () => ({ MediaSettings: marker("MediaSettings") }));
vi.mock("./screens/NotificationPreferences", () => ({ NotificationPreferences: marker("NotificationPreferences") }));
vi.mock("./screens/PrivacySettings", () => ({ PrivacySettings: marker("PrivacySettings") }));
vi.mock("./screens/AiSettings", () => ({ AiSettings: marker("AiSettings") }));
vi.mock("./screens/AiAdvanced", () => ({ AiAdvanced: marker("AiAdvanced") }));
vi.mock("./screens/HelpGuide", () => ({ HelpGuide: marker("HelpGuide") }));
vi.mock("./screens/Diagnostics", () => ({ Diagnostics: marker("Diagnostics") }));

import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "./services/onboarding";
import { App, createAppRouter } from "./App";
let router: ReturnType<typeof createAppRouter> | undefined;

const origin = "https://findbackapp.social";
const postId = "5b6f7c8d-1234-4abc-8def-123456789012";

function renderAt(hash: string) {
  router?.dispose();
  window.history.replaceState(null, "", `/#${hash}`);
  router = createAppRouter();
  return render(<App router={router} />);
}

function returningGuest() {
  auth.user = null;
  localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
}

function signedIn() {
  // A complete PublicUser: the shell and guards must never rely on a
  // partial fixture, and a crash from a missing field must fail loudly.
  auth.user = {
    id: "u1",
    username: "route-tester",
    email: "routes@test.example",
    phone: "+15550001111",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

// An error boundary also renders text: asserting "body has text" would pass
// a crashed route. The afterEach guard proves the crash screen is absent on
// every route, so the per-route marker assertions stay meaningful.

const unexpectedErrors: unknown[][] = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
  auth.user = null;
  auth.booting = false;
  auth.bootError = null;
  localStorage.clear();
  sessionStorage.clear();
  unexpectedErrors.length = 0;
  editorPosts.load.mockReset();
  editorPosts.save.mockReset();
  editorPosts.load.mockResolvedValue({
    id: "p1", userId: "u1", type: "LOST", status: "OPEN", title: "Original title",
    description: "A sufficiently long original description", category: "Electronics", eventDate: "2020-01-01",
    locationLabel: "", latitude: null, longitude: null, youtubeUrl: null, attachments: [],
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    unexpectedErrors.push(args);
  });
  // jsdom lacks scrollIntoView; routes that scroll on navigation must not crash.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  try {
    // A crashed route renders the boundary instead of the screen: every
    // route test must prove the crash screen is absent (text assertions
    // alone would pass on the boundary's own copy).
    expect(screen.queryByText("Something went wrong")).toBeNull();
    const suspicious = unexpectedErrors.filter((args) => {
      const text = args.map(String).join(" ");
      // jsdom capability noise, not app crashes (e.g. navigation stubs).
      return !/not implemented|jsdom|Warning: .*act\b/i.test(text);
    });
    expect(suspicious, `unexpected console.error on this route: ${JSON.stringify(suspicious).slice(0, 800)}`).toEqual([]);
  } finally {
    cleanup();
    router?.dispose();
    vi.unstubAllEnvs();
    native.back = null;
    window.history.replaceState(null, "", "/");
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
    vi.restoreAllMocks();
  }
});

describe("consumer route map", () => {
  it("protects the actual cold hash Edit route on Android back, asking only once per press", async () => {
    signedIn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAt("/my/p1/edit");
    const title = await screen.findByLabelText("What did you lose?");
    fireEvent.change(title, { target: { value: "Keep this draft" } });
    act(() => native.back?.());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/my/p1/edit");
    expect((title as HTMLInputElement).value).toBe("Keep this draft");
    confirm.mockReturnValue(true);
    act(() => native.back?.());
    await screen.findByText("Home screen");
    expect(window.location.hash).toBe("#/");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("does not redirect a new destination when a save settles during the Edit exit animation", async () => {
    signedIn();
    let resolve!: (value: unknown) => void;
    editorPosts.save.mockReturnValue(new Promise((res) => { resolve = res; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("/my/p1/edit");
    fireEvent.change(await screen.findByLabelText("What did you lose?"), { target: { value: "Pending save title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => { await router!.navigate("/profile"); resolve({}); });
    await waitFor(() => expect(window.location.hash).toBe("#/profile"));
    expect(await screen.findByText("Profile screen")).toBeTruthy();
  });

  it("keeps a returned editor usable when Back reverses its exit animation", async () => {
    signedIn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("/my/p1/edit");
    fireEvent.change(await screen.findByLabelText("What did you lose?"), { target: { value: "Departing title" } });
    await act(async () => { await router!.navigate("/profile"); });
    await act(async () => { await router!.navigate(-1); });
    expect(window.location.hash).toBe("#/my/p1/edit");
    const title = await screen.findByLabelText("What did you lose?");
    await waitFor(() => expect((title as HTMLInputElement).value).toBe("Original title"));
    fireEvent.change(title, { target: { value: "Returned title" } });
    expect((title as HTMLInputElement).value).toBe("Returned title");
  });

  it("does not ask the exiting editor to guard a subsequent destination", async () => {
    signedIn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAt("/my/p1/edit");
    fireEvent.change(await screen.findByLabelText("What did you lose?"), { target: { value: "Departing title" } });
    await act(async () => { await router!.navigate("/profile"); });
    await act(async () => { await router!.navigate("/my"); });
    expect(window.location.hash).toBe("#/my");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("renders first-run onboarding for a fresh guest", () => {
    renderAt("/onboarding");
    expect(screen.getByText("Onboarding screen")).toBeTruthy();
  });

  it.each([
    ["/auth", "Gateway:email"],
    ["/signin", "Gateway:signin"],
    ["/register", "Gateway:signup"],
  ])("renders %s in the right gateway mode for a returning guest", (route, markerText) => {
    returningGuest();
    renderAt(route);
    expect(screen.getByText(markerText)).toBeTruthy();
  });

  it("redirects a fresh guest away from /auth to onboarding", () => {
    renderAt("/auth");
    expect(screen.getByText("Onboarding screen")).toBeTruthy();
  });

  it("renders the verify screen", () => {
    returningGuest();
    renderAt("/verify");
    expect(screen.getByText("Verify screen")).toBeTruthy();
  });

  it.each([
    ["/forgot", "ForgotPassword screen"],
    ["/recovery", "Recovery screen"],
  ])("renders public recovery route %s without auth", (route, markerText) => {
    renderAt(route);
    expect(screen.getByText(markerText)).toBeTruthy();
  });

  it.each([
    ["/profile", "Profile screen"],
    ["/settings", "Settings screen"],
    ["/settings/administrator", "AdminBootstrap screen"],
    ["/settings/account", "AccountSettings screen"],
    ["/settings/appearance", "AppearanceSettings screen"],
    ["/settings/accessibility", "AccessibilitySettings screen"],
    ["/settings/feed-layout", "FeedLayoutSettings screen"],
    ["/settings/media", "MediaSettings screen"],
    ["/settings/notifications", "NotificationPreferences screen"],
    ["/settings/privacy", "PrivacySettings screen"],
    ["/settings/privacy/blocked", "BlockedUsers screen"],
    ["/settings/privacy/reports", "SafetyReports screen"],
    ["/settings/feedback", "FeedbackForm screen"],
    ["/settings/returns", "Returns screen"],
    ["/settings/ai", "AiSettings screen"],
    ["/settings/ai/connections", "AiConnection screen"],
    ["/settings/ai/models", "AiModelsRoute screen"],
    ["/settings/local-intelligence", "LocalIntelligence screen"],
    ["/settings/local-intelligence/downloads", "DownloadedModels screen"],
    ["/settings/ai/advanced", "AiAdvanced screen"],
    ["/settings/help", "HelpGuide screen"],
    ["/settings/about", "About screen"],
    ["/settings/diagnostics", "Diagnostics screen"],
    ["/profile/edit", "ProfileEdit screen"],
    ["/my", "MyPosts screen"],
    ["/notifications", "Notifications screen"],
    ["/search", "Search screen"],
    ["/report", "CreateReport screen"],
    ["/ai-models", "AiModelsRoute screen"],
  ])("renders signed route %s inside the shell", (route, markerText) => {
    signedIn();
    renderAt(route);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(screen.getByText(markerText)).toBeTruthy();
  });

  it.each([
    ["/help", "Help screen"],
    ["/ai-connection", "AiConnection screen"],
  ])("renders %s without bottom nav (hidden by Shell design)", (route, markerText) => {
    signedIn();
    renderAt(route);
    expect(screen.getByText(markerText)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("keeps the legacy /about route rendering About", () => {
    signedIn();
    renderAt("/about");
    expect(screen.getByText("About screen")).toBeTruthy();
  });

  it("keeps the /offline-ai redirect on the canonical on-device settings area", () => {
    signedIn();
    renderAt("/offline-ai");
    expect(screen.getByText("AiModelsRoute screen")).toBeTruthy();
  });

  it("renders the public shared report without auth", () => {
    renderAt(`/shared/${postId}`);
    expect(screen.getByText("SharedReport screen")).toBeTruthy();
  });

  it("guards signed routes: fresh guests go to onboarding, returning guests to auth", () => {
    renderAt("/settings/appearance");
    expect(screen.getByText("Onboarding screen")).toBeTruthy();
    cleanup();
    returningGuest();
    renderAt("/settings/appearance");
    expect(screen.getByText("Gateway:email")).toBeTruthy();
  });

  it("requires sign-in, not an existing admin role, for administrator setup", () => {
    returningGuest();
    renderAt("/settings/administrator");
    expect(screen.getByText("Gateway:email")).toBeTruthy();
    expect(screen.queryByText("AdminBootstrap screen")).toBeNull();
    cleanup();
    signedIn();
    renderAt("/settings/administrator");
    expect(screen.getByText("AdminBootstrap screen")).toBeTruthy();
  });

  it("resumes a pending shared-report link after sign-in", () => {
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    signedIn();
    renderAt("/");
    expect(screen.getByText("PostDetail screen")).toBeTruthy();
    expect(sessionStorage.getItem("findback.pendingReportLink")).toBeNull();
  });
});
