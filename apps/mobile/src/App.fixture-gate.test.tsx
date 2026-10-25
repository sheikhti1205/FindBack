// @vitest-environment jsdom
// FB-AUD-07: /__fixture must be dev/audit-only. The route entry in App.tsx
// is gated on import.meta.env.DEV (the repo's existing build-flag convention,
// cf. Splash.tsx / bootDiagnostics.ts): Vite statically replaces DEV with
// false in production builds, so the route is compiled out of prod while
// dev + test keep working. FixtureRoute itself is mocked here on purpose —
// this suite proves the *route entry* gate, while fixture.test.tsx renders
// the real FixtureRoute directly for content coverage.
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
    addListener: () => Promise.resolve({ remove: () => {} }),
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
vi.mock("./screens/Splash", () => ({ Splash: () => <p>Splash screen</p> }));
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
vi.mock("./screens/HelpGuide", () => ({ HelpGuide: marker("HelpGuide") }));
vi.mock("./screens/Diagnostics", () => ({ Diagnostics: marker("Diagnostics") }));
vi.mock("./fixture/FixtureRoute", () => ({ FixtureRoute: () => <p>Fixture screen</p> }));

import { App, createAppRouter } from "./App";
let router: ReturnType<typeof createAppRouter> | undefined;

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/#${hash}`);
  router = createAppRouter();
  return render(<App router={router} />);
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social");
  auth.user = null;
  auth.booting = false;
  auth.bootError = null;
  localStorage.clear();
  sessionStorage.clear();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  try {
    expect(screen.queryByText("Something went wrong")).toBeNull();
  } finally {
    cleanup();
    router?.dispose();
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  }
});

describe("FB-AUD-07 fixture route gate", () => {
  it("exposes /__fixture when DEV is on (dev/audit builds)", () => {
    vi.stubEnv("DEV", true);
    renderAt("/__fixture");
    expect(screen.getByText("Fixture screen")).toBeTruthy();
  });

  it("hides /__fixture when DEV is off (production build)", async () => {
    vi.stubEnv("DEV", false);
    renderAt("/__fixture");
    // The route is gone: the catch-all redirects to /splash instead.
    expect(screen.queryByText("Fixture screen")).toBeNull();
    expect(await screen.findByText("Splash screen")).toBeTruthy();
  });
});
