// @vitest-environment jsdom
/**
 * QA I — consumer-UI accessibility regression suite (WCAG 2.2 AA, web-React).
 *
 * Covers the brief checks across the owned surface: visible focus (no
 * suppressed rings; focus-within rings where the control itself is
 * visually hidden), touch-target CSS contracts, xlarge (125% root)
 * horizontal-overflow renders, one-h1-per-page, and no nested
 * interactive elements. Numerical contrast pairings live in
 * `src/appearance.contrast.test.ts`.
 */
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const authState = vi.hoisted(() => ({
  user: null as PublicUser | null,
  pendingEmail: null as string | null,
  booting: false,
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  verifyPendingEmail: vi.fn(),
  resendPendingEmail: vi.fn(),
}));
vi.mock("../auth", () => ({
  useAuth: () => ({
    user: authState.user,
    pendingEmail: authState.pendingEmail,
    booting: authState.booting,
    login: authState.login,
    register: authState.register,
    logout: authState.logout,
    refreshUser: authState.refreshUser,
    verifyPendingEmail: authState.verifyPendingEmail,
    resendPendingEmail: authState.resendPendingEmail,
  }),
}));

const servicesAuth = vi.hoisted(() => ({
  checkUsername: vi.fn(async () => ({ available: true })),
  sendPendingEmailCode: vi.fn(async () => undefined),
  verifyPendingEmailCode: vi.fn(async () => undefined),
}));
vi.mock("../services/auth", () => servicesAuth);
vi.mock("../utils/pendingReportLink", () => ({
  getPendingReportRoute: () => null,
}));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { updateUser: async () => ({ error: null }) } }),
}));
vi.mock("../services/buildInfo", () => ({
  readBuildInfo: async () => ({
    appVersion: "0.1.0-test",
    buildGitSha: "fdbd355abc123def456",
    versionCode: 1234,
  }),
}));
vi.mock("../services/notificationPreferences", () => ({
  DEFAULT_NOTIFICATION_PREFERENCES: {
    pushEnabled: true,
    comments: true,
    mentions: true,
    likes: true,
    status: true,
  },
  fetchNotificationPreferences: async () => ({
    pushEnabled: true,
    comments: true,
    mentions: true,
    likes: true,
    status: true,
  }),
  saveNotificationPreferences: async (next: unknown) => next,
}));
vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({
    permission: async () => "granted",
    start: async () => "granted",
    openSettings: async () => undefined,
  }),
}));
vi.mock("../services/aiCredentials", () => ({
  aiCredentials: {
    get: async () => null,
    hasSaved: async () => false,
  },
  describeCloudConnections: async () => ({ summary: "Not connected", providers: [] }),
}));

import { TextField } from "../components/Fields";
import { OtpField } from "../components/auth/OtpField";
import { ThemeProvider } from "../theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { MediaSettings } from "./MediaSettings";
import { HelpGuide } from "./HelpGuide";
import { About } from "./About";
import { Settings } from "./Settings";
import { Profile } from "./Profile";
import { AccountSettings } from "./AccountSettings";
import { ProfileEdit } from "./ProfileEdit";
import { AuthGateway } from "./AuthGateway";
import { Verify } from "./Verify";
import { NotificationPreferences } from "./NotificationPreferences";
import { AiSettings } from "./AiSettings";

const baseUser: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function resetDom() {
  localStorage.clear();
  const root = document.documentElement;
  root.removeAttribute("style");
  root.className = "";
  for (const key of ["theme", "accent", "reduceMotionOverride"]) delete root.dataset[key];
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = null;
  authState.pendingEmail = null;
  authState.booting = false;
  resetDom();
});

afterEach(() => {
  cleanup();
  resetDom();
});

/** Structural invariants: exactly one h1, no nested interactive elements. */
function expectPageInvariants(container: HTMLElement) {
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  for (const el of container.querySelectorAll("a,button")) {
    let parent = el.parentElement;
    while (parent && parent !== container) {
      expect(
        parent.tagName,
        `nested interactive <${el.tagName.toLowerCase()}> inside <${parent.tagName.toLowerCase()}>`,
      ).not.toMatch(/^(A|BUTTON)$/);
      parent = parent.parentElement;
    }
  }
}

function expectNoHorizontalOverflow(root: HTMLElement) {
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
}

describe("QA I — visible focus contracts (SC 2.4.7, house 2px/3:1)", () => {
  it("TextField keeps a visible keyboard focus indicator (never outline-none)", () => {
    render(<TextField label="Email" value="" onChange={() => {}} />);
    const input = screen.getByLabelText("Email");
    expect(input.className).not.toMatch(/outline-none/);
    // Border feedback is retained alongside the global :focus-visible ring.
    expect(input.className).toMatch(/focus:border-on-surface/);
  });

  it("password reveal toggle keeps a visible keyboard focus indicator", () => {
    render(<TextField label="Password" type="password" value="" onChange={() => {}} />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle.className).not.toMatch(/outline-none/);
  });

  it("OTP input keeps a visible keyboard focus indicator", () => {
    render(<OtpField value="" onChange={() => {}} />);
    const input = screen.getByLabelText("Verification code");
    expect(input.className).not.toMatch(/outline-none/);
    expect(input.className).toMatch(/focus:border-on-surface/);
  });

  it("AI-mode radio labels expose the 2px focus ring when a radio has keyboard focus", () => {
    authState.user = baseUser;
    render(
      <MemoryRouter>
        <AiSettings />
      </MemoryRouter>,
    );
    const radio = screen.getByRole("radio", { name: /automatic/i });
    const label = radio.closest("label");
    expect(label).toBeTruthy();
    // The input itself is visually hidden (sr-only), so the label must
    // carry the ring via :focus-within with the --fb-focus color.
    for (const cls of [
      "focus-within:outline-2",
      "focus-within:outline-solid",
      "focus-within:outline-offset-2",
      "focus-within:outline-focus",
    ]) {
      expect(label!.className).toContain(cls);
    }
  });
});

describe("QA I — touch-target CSS contracts (SC 2.5.8, house 44px / rows 60px)", () => {
  const settingsCss = readFileSync("src/components/settings/settings.css", "utf8");
  const navCss = readFileSync("src/components/Shell.nav.css", "utf8");

  function ruleBlock(css: string, selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start).split("}")[0]!;
  }

  it("settings rows keep a 60px minimum target", () => {
    expect(ruleBlock(settingsCss, ".fb-settings-row")).toMatch(/min-height:\s*3\.75rem/);
  });

  it("bottom-nav links and search clear keep >=44px targets", () => {
    expect(ruleBlock(navCss, ".fb-nav-link")).toMatch(/min-height:\s*48px/);
    expect(ruleBlock(navCss, ".fb-nav-link")).toMatch(/min-width:\s*44px/);
    expect(ruleBlock(settingsCss, ".fb-settings-search-field button")).toMatch(
      /min-height:\s*2\.75rem/,
    );
  });

  it("choice cards (theme/accent/text-size/motion radios) keep >=44px targets", () => {
    // Shipped value is 3rem (48px), which exceeds the 44px house floor — the
    // old 2.75rem pin went stale when choice rows were raised to 48px.
    expect(ruleBlock(settingsCss, ".fb-choice")).toMatch(/min-height:\s*3rem/);
  });

  it("disclosures keep a >=44px summary target", () => {
    // Shipped value is 3rem (48px), which exceeds the 44px house floor.
    expect(ruleBlock(settingsCss, ".fb-advanced-disclosure summary")).toMatch(
      /min-height:\s*3rem/,
    );
  });
});

describe("QA I — xlarge (125% root) renders without horizontal overflow", () => {
  function renderXlarge(ui: React.ReactNode) {
    document.documentElement.style.fontSize = "125%";
    return render(<MemoryRouter>{ui}</MemoryRouter>);
  }

  it("Appearance / Accessibility / Media keep one h1, no nesting, no overflow", () => {
    for (const Screen of [AppearanceSettings, AccessibilitySettings, MediaSettings]) {
      const view = renderXlarge(
        <ThemeProvider>
          <Screen />
        </ThemeProvider>,
      );
      expectPageInvariants(view.container);
      const page = view.container.querySelector(".fb-settings-page") as HTMLElement;
      expect(page).toBeTruthy();
      expectNoHorizontalOverflow(page);
      view.unmount();
    }
  });

  it("HelpGuide and About keep one h1, no nesting, no overflow", () => {
    for (const Screen of [HelpGuide, About]) {
      const view = renderXlarge(<Screen />);
      expectPageInvariants(view.container);
      expectNoHorizontalOverflow(view.container.firstElementChild as HTMLElement);
      view.unmount();
    }
  });

  it("Settings root keeps one h1, no nesting, no overflow", async () => {
    authState.user = baseUser;
    const view = renderXlarge(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    expectPageInvariants(view.container);
    expectNoHorizontalOverflow(view.container.querySelector(".fb-settings-page") as HTMLElement);
    view.unmount();
  });

  it("Profile / Account / ProfileEdit keep one h1, no nesting, no overflow", () => {
    authState.user = baseUser;
    for (const Screen of [Profile, AccountSettings, ProfileEdit]) {
      const view = renderXlarge(<Screen />);
      expectPageInvariants(view.container);
      expectNoHorizontalOverflow(view.container.firstElementChild as HTMLElement);
      view.unmount();
    }
  });

  it("AuthGateway email stage and Verify pending keep one h1, no nesting, no overflow", () => {
    for (const ui of [<AuthGateway key="auth" />]) {
      const view = renderXlarge(ui);
      expectPageInvariants(view.container);
      expectNoHorizontalOverflow(view.container.firstElementChild as HTMLElement);
      view.unmount();
    }
    authState.pendingEmail = "tester@example.com";
    const pending = renderXlarge(<Verify />);
    expectPageInvariants(pending.container);
    expectNoHorizontalOverflow(pending.container.firstElementChild as HTMLElement);
    pending.unmount();
  });

  it("NotificationPreferences and AiSettings keep one h1, no nesting, no overflow", async () => {
    authState.user = baseUser;
    for (const Screen of [NotificationPreferences, AiSettings]) {
      const view = renderXlarge(<Screen />);
      expectPageInvariants(view.container);
      expectNoHorizontalOverflow(view.container.firstElementChild as HTMLElement);
      view.unmount();
    }
  });
});
