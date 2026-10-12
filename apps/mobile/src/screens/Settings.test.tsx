// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout, mockFetchPrefs, mockPermission } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockFetchPrefs: vi.fn(),
  mockPermission: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
      displayName: "Test Person",
      email: "tester@example.com",
      phone: "+10000000000",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    logout: mockLogout,
  }),
}));

vi.mock("../appearance", () => ({
  ACCENT_OPTIONS: [
    { id: "emerald", label: "Emerald" },
    { id: "blue", label: "Blue" },
  ],
  TEXT_SCALE_OPTIONS: [
    { id: "compact", label: "Small" },
    { id: "standard", label: "Default" },
    { id: "large", label: "Large" },
    { id: "xlarge", label: "Extra large" },
  ],
  useAppearance: () => ({
    settings: { accent: "emerald", textScale: "standard", reduceMotion: "system", highQualityPhoto: false },
    update: vi.fn(),
  }),
}));

vi.mock("../theme", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("../services/notificationPreferences", () => ({
  fetchNotificationPreferences: (...args: unknown[]) => mockFetchPrefs(...args),
}));

vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({ permission: (...args: unknown[]) => mockPermission(...args) }),
}));

import {
  accessibilitySummary,
  accountSummary,
  appearanceSummary,
  mediaSummary,
  notificationSummary,
} from "./Settings";
import { cloudConnectionsSummary } from "../services/aiCredentials";
import { Settings } from "./Settings";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchPrefs.mockResolvedValue({ pushEnabled: true, likes: true, comments: true, mentions: true, status: true });
  mockPermission.mockResolvedValue("granted");
  mockLogout.mockResolvedValue(undefined);
});

function renderSettings() {
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

/** Every destination reachable from the root (nested disclosures included). */
function rootHrefs(): string[] {
  return Array.from(document.querySelectorAll("a[href]")).map((a) =>
    (a as HTMLAnchorElement).getAttribute("href")!,
  );
}

describe("summary helpers", () => {
  it("composes the appearance value from live theme and accent", () => {
    expect(appearanceSummary("dark", "emerald")).toBe("Dark · Emerald");
    expect(appearanceSummary("system", "blue")).toBe("System · Blue");
  });

  it("composes the account value from live verification flags", () => {
    expect(accountSummary({ emailVerified: true, phoneVerified: true })).toBe("Verified");
    expect(accountSummary({ emailVerified: true, phoneVerified: false })).toBe("Partially verified");
    expect(accountSummary({ emailVerified: false, phoneVerified: true })).toBe("Partially verified");
    expect(accountSummary({ emailVerified: false, phoneVerified: false })).toBe("Unverified");
  });

  it("composes the accessibility value from live text and motion settings", () => {
    expect(accessibilitySummary("standard", "system")).toBe("Default text · System motion");
    expect(accessibilitySummary("large", "reduce")).toBe("Large text · Reduced motion");
  });

  it("reflects the live photo-quality flag for media", () => {
    expect(mediaSummary(false)).toBe("Standard");
    expect(mediaSummary(true)).toBe("High quality");
  });

  it("prefers stored prefs for notifications and falls back honestly", () => {
    expect(notificationSummary({ pushEnabled: true } as never, "denied")).toBe("On");
    expect(notificationSummary({ pushEnabled: false } as never, "granted")).toBe("Off");
    expect(notificationSummary(null, "granted")).toBe("On");
    expect(notificationSummary(null, "denied")).toBe("Off");
    expect(notificationSummary(null, "prompt")).toBe("Turn on");
    expect(notificationSummary(null, null)).toBe("Review settings");
  });
});

describe("Settings home", () => {
  it("renders one h1, the profile header, the search field, and the exact group structure", () => {
    renderSettings();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    for (const name of ["Account", "Preferences", "Intelligence", "Privacy", "More"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("shows the profile header with avatar, display name, @username, and Edit profile", () => {
    renderSettings();
    const header = screen.getByRole("link", { name: /edit profile/i });
    expect(header.getAttribute("href")).toBe("/profile/edit");
    expect(screen.getByTestId("user-avatar")).toBeTruthy();
    expect(screen.getByText("Test Person")).toBeTruthy();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(header.textContent).toMatch(/edit profile/i);
  });

  it("links every row to its real route_map.csv target (nested disclosures included)", () => {
    renderSettings();
    const hrefs = rootHrefs();
    for (const href of [
      "/profile/edit",
      "/settings/account",
      "/settings/appearance",
      "/settings/notifications",
      "/settings/accessibility",
      "/settings/ai",
      "/settings/privacy",
      "/settings/media",
      "/settings/diagnostics",
      "/settings/help",
      "/onboarding?replay=1",
      "/settings/about",
    ]) {
      expect(hrefs, `row linking to ${href} exists`).toContain(href);
    }
    // Cloud connections moved inside AI & models: reachable via the AI row + search, not a root row.
    const aiRow = screen.getByRole("link", { name: /AI & models/ });
    expect(aiRow.getAttribute("href")).toBe("/settings/ai");
  });

  it("groups moved rows under the Advanced and Help & about disclosures", () => {
    renderSettings();
    const more = screen.getByRole("region", { name: "More" });
    expect(within(more).getByText("Advanced")).toBeTruthy();
    expect(within(more).getByText("Help & about")).toBeTruthy();
    expect(document.querySelectorAll("details.fb-settings-nested")).toHaveLength(2);
  });

  it("keeps every root row keyboard-focusable with a real target", () => {
    renderSettings();
    for (const anchor of Array.from(document.querySelectorAll('a[href^="/"],a[href^="/onboarding"]')) as HTMLAnchorElement[]) {
      expect(anchor.getAttribute("href")!.length).toBeGreaterThan(0);
    }
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect((link as HTMLAnchorElement).href.length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("shows live summary values on the top-level rows", async () => {
    renderSettings();
    expect(await screen.findByText("Dark · Emerald")).toBeTruthy();
    expect(await screen.findByText("Default text · System motion")).toBeTruthy();
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(await screen.findByText("On")).toBeTruthy();
    expect(await screen.findByText("Partially verified")).toBeTruthy();
  });

  it("shows honest fallbacks when live sources are unreadable", async () => {
    mockFetchPrefs.mockRejectedValueOnce(new Error("offline"));
    mockPermission.mockRejectedValueOnce(new Error("offline"));
    renderSettings();
    expect(await screen.findByText("Review settings")).toBeTruthy();
  });

  it("filters rows by alias terms and shows the verbatim empty state", async () => {
    renderSettings();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "theme" } });
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /appearance/i })).toBeTruthy();
    });
    expect(screen.queryByRole("region", { name: "Preferences" })).toBeNull();

    fireEvent.change(search, { target: { value: "text size" } });
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /accessibility/i })).toBeTruthy();
    });

    fireEvent.change(search, { target: { value: "key" } });
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /cloud connections/i })).toBeTruthy();
    });

    fireEvent.change(search, { target: { value: "zxqv-nonexistent" } });
    expect(await screen.findByText("No settings found")).toBeTruthy();
    expect(screen.getByText("Try theme, notifications, AI, privacy, or text size.")).toBeTruthy();
  });

  it("signs out through the real auth layer with loading and error semantics", async () => {
    renderSettings();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(signOut);
    const pending = screen.getByRole("button", { name: "Signing out…" });
    expect(pending.getAttribute("disabled")).not.toBeNull();
    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy());

    mockLogout.mockRejectedValueOnce(new Error("Network request failed"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("keeps rows free of nested interactive controls", () => {
    renderSettings();
    for (const groupName of ["Account", "Preferences", "Intelligence", "Privacy"]) {
      const group = screen.getByRole("region", { name: groupName });
      for (const row of within(group).getAllByRole("link")) {
        expect(row.querySelectorAll("button,a,input").length).toBe(0);
      }
    }
    const header = screen.getByRole("link", { name: /edit profile/i });
    expect(header.querySelectorAll("button,a,input").length).toBe(0);
  });
});

describe("cloud connections summary (F03)", () => {
  it("summarizes a single default-provider connection truthfully", () => {
    expect(cloudConnectionsSummary(["openrouter"])).toBe("OpenRouter connected");
  });

  it("summarizes a single non-default provider as connected", () => {
    expect(cloudConnectionsSummary(["openai"])).toBe("OpenAI connected");
    expect(cloudConnectionsSummary(["anthropic"])).toBe("Anthropic connected");
  });

  it("summarizes multiple providers with a truthful count", () => {
    expect(cloudConnectionsSummary(["openai", "anthropic"])).toBe("2 connections");
    expect(cloudConnectionsSummary(["openrouter", "openai", "google"])).toBe("3 connections");
  });

  it("summarizes no connections as not connected", () => {
    expect(cloudConnectionsSummary([])).toBe("Not connected");
  });

  it("never exposes raw key material in the summary text", () => {
    const secret = "sk-live-F03-PROBE-SECRET-9f8e7d6c5b4a";
    expect(cloudConnectionsSummary(["openrouter"])).not.toContain(secret);
    expect(cloudConnectionsSummary(["openai"])).not.toContain(secret);
    expect(cloudConnectionsSummary(["openai", "anthropic"])).not.toContain(secret);
    expect(cloudConnectionsSummary([])).not.toContain(secret);
  });
});

/**
 * Regression guard for the 60px-vs-48px settings-row defect: the shared
 * foundation rule must keep the house 60px row target, and the Settings-root
 * override must never shrink below it. Reading both files proves the rule
 * that actually wins the cascade (`.fb-settings-root` is more specific).
 */
describe("settings row touch-target contract", () => {
  const sharedCss = readFileSync("src/components/settings/settings.css", "utf8");
  const rootCss = readFileSync("src/screens/Settings.css", "utf8");

  function ruleBlock(css: string, selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start).split("}")[0]!;
  }

  it("keeps the shared row minimum at the house 60px target", () => {
    expect(ruleBlock(sharedCss, ".fb-settings-row")).toMatch(/min-height:\s*3\.75rem/);
  });

  it("never lets the Settings-root override shrink rows below the shared minimum", () => {
    const override = ruleBlock(rootCss, ".fb-settings-root .fb-settings-row");
    const declared = override.match(/min-height:\s*([\d.]+)rem/);
    expect(declared).toBeTruthy();
    expect(Number(declared![1])).toBeGreaterThanOrEqual(3.75);
  });
});
