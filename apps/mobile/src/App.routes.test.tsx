// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
vi.mock("./screens/Notifications", () => ({ Notifications: () => <p>Notifications screen</p> }));
vi.mock("./screens/SharedReport", () => ({ SharedReport: () => <p>SharedReport screen</p> }));
vi.mock("./screens/Settings", () => ({ Settings: marker("Settings") }));
vi.mock("./screens/AccountSettings", () => ({ AccountSettings: marker("AccountSettings") }));
vi.mock("./screens/AppearanceSettings", () => ({ AppearanceSettings: marker("AppearanceSettings") }));
vi.mock("./screens/AccessibilitySettings", () => ({ AccessibilitySettings: marker("AccessibilitySettings") }));
vi.mock("./screens/MediaSettings", () => ({ MediaSettings: marker("MediaSettings") }));
vi.mock("./screens/NotificationPreferences", () => ({ NotificationPreferences: marker("NotificationPreferences") }));
vi.mock("./screens/PrivacySettings", () => ({ PrivacySettings: marker("PrivacySettings") }));
vi.mock("./screens/AiSettings", () => ({ AiSettings: marker("AiSettings") }));
vi.mock("./screens/AiAdvanced", () => ({ AiAdvanced: marker("AiAdvanced") }));
vi.mock("./screens/HelpGuide", () => ({ HelpGuide: marker("HelpGuide") }));
vi.mock("./screens/Diagnostics", () => ({ Diagnostics: marker("Diagnostics") }));

import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "./services/onboarding";
import { App } from "./App";

const origin = "https://findbackapp.social";
const postId = "5b6f7c8d-1234-4abc-8def-123456789012";

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/#${hash}`);
  return render(<App />);
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
    vi.unstubAllEnvs();
    native.back = null;
    window.history.replaceState(null, "", "/");
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
  }
});

describe("consumer route map", () => {
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
    ["/settings/account", "AccountSettings screen"],
    ["/settings/appearance", "AppearanceSettings screen"],
    ["/settings/accessibility", "AccessibilitySettings screen"],
    ["/settings/media", "MediaSettings screen"],
    ["/settings/notifications", "NotificationPreferences screen"],
    ["/settings/privacy", "PrivacySettings screen"],
    ["/settings/ai", "AiSettings screen"],
    ["/settings/ai/connections", "AiConnection screen"],
    ["/settings/ai/models", "AiModelsRoute screen"],
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
