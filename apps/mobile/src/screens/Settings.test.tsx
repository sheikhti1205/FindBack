// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout, mockFetchPrefs, mockPermission, mockFetchMyRole, mockBootstrapStatus, viewer } = vi.hoisted(() => ({
  viewer: { id: "u1" },
  mockLogout: vi.fn(),
  mockFetchPrefs: vi.fn(),
  mockPermission: vi.fn(),
  mockFetchMyRole: vi.fn(),
  mockBootstrapStatus: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: viewer.id,
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

// The staff console entry is decided by the SERVER's role, never by a local
// flag. The service is mocked, not the network.
vi.mock("../services/roles", () => ({
  fetchMyRole: (...args: unknown[]) => mockFetchMyRole(...args),
  fetchBootstrapClaimStatus: (...args: unknown[]) => mockBootstrapStatus(...args),
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
  viewer.id = "u1";
  vi.clearAllMocks();
  mockFetchPrefs.mockResolvedValue({ pushEnabled: true, likes: true, comments: true, mentions: true, status: true });
  mockPermission.mockResolvedValue("granted");
  mockLogout.mockResolvedValue(undefined);
  // An ordinary account by default: no role, no capabilities.
  mockFetchMyRole.mockResolvedValue({ role: null, isAdmin: false, capabilities: [] });
  mockBootstrapStatus.mockResolvedValue({ canClaim: false, reason: "An admin already exists", alreadyAdmin: false, hasAdmin: true });
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
  it("offers recovered items and feedback without needing a staff role", () => {
    renderSettings();
    expect(screen.getByRole("link", { name: /Recovered items/i }).getAttribute("href")).toBe("/settings/returns");
    expect(screen.getByRole("link", { name: /Send feedback/i }).getAttribute("href")).toBe("/settings/feedback");
  });

  it("exposes administrator setup only after caller eligibility resolves true", async () => {
    let resolve!: (value: unknown) => void;
    mockBootstrapStatus.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderSettings();
    expect(screen.queryByRole("link", { name: /Become the administrator/i })).toBeNull();
    resolve({ canClaim: true, reason: null, alreadyAdmin: false, hasAdmin: false });
    const entry = await screen.findByRole("link", { name: /Become the administrator/i });
    expect(entry.getAttribute("href")).toBe("/settings/administrator");
  });

  it("does not advertise administrator setup to ordinary accounts", async () => {
    renderSettings();
    await waitFor(() => expect(mockBootstrapStatus).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Administrator" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Become the administrator/i })).toBeNull();
  });

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

  it("offers the local surfaces from the Intelligence group", () => {
    renderSettings();
    const group = screen.getByRole("region", { name: "Intelligence" });
    expect(within(group).getByRole("link", { name: /Local intelligence/ })).toBeTruthy();
    expect(within(group).getByRole("link", { name: /AI & models/ })).toBeTruthy();
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
      "/settings/local-intelligence",
      "/settings/privacy",
      "/settings/media",
      "/settings/diagnostics",
      "/settings/help",
      "/onboarding?replay=1",
      "/settings/about",
      "/settings/terms",
      "/settings/privacy-policy",
      "/settings/community-guidelines",
    ]) {
      expect(hrefs, `row linking to ${href} exists`).toContain(href);
    }
    // Cloud connections moved inside AI & models: reachable via the AI row + search, not a root row.
    const aiRow = screen.getByRole("link", { name: /AI & models/ });
    expect(aiRow.getAttribute("href")).toBe("/settings/ai");
  });

  it("routes Local intelligence to the consumer local surfaces, not the technical catalogue", () => {
    renderSettings();
    const row = screen.getByRole("link", { name: /Local intelligence/ });
    expect(row.getAttribute("href")).toBe("/settings/local-intelligence");
    expect(row.textContent).toMatch(/on this phone/i);
  });

  it("offers the CF-010 feed layout row, showing what it resolves to on this screen", () => {
    renderSettings();
    // jsdom is 1024 wide: the Auto default resolves to the photo grid, and the
    // row says so rather than leaving the reader to guess behind a bare "Auto".
    const row = screen.getByRole("link", { name: /Feed layout/ });
    expect(row.getAttribute("href")).toBe("/settings/feed-layout");
    expect(row.textContent).toMatch(/Auto · Masonry/);
  });

  it("states the feed layout in the row once the reader picks one", () => {
    localStorage.setItem("findback.feedLayout.v1", JSON.stringify("compact"));
    renderSettings();
    expect(screen.getByRole("link", { name: /Feed layout/ }).textContent).toMatch(/Compact/);
  });

  it("groups moved rows under the Advanced, Legal and Help & about disclosures", () => {
    renderSettings();
    const more = screen.getByRole("region", { name: "More" });
    expect(within(more).getByText("Advanced")).toBeTruthy();
    expect(within(more).getByText("Legal")).toBeTruthy();
    expect(within(more).getByText("Help & about")).toBeTruthy();
    expect(document.querySelectorAll("details.fb-settings-nested")).toHaveLength(3);
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
      expect(screen.getByRole("link", { name: /providers/i })).toBeTruthy();
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

/**
 * The staff console entry (CONTRACT-ROLES-ADMIN-2026-10-22.md §A2.5).
 *
 * Team administration is ADMIN-only; review access is a separate capability.
 */
describe("the staff console entry", () => {
  it.each(["appeals_review", "feedback_read"])("offers only the permitted %s destination", async capability => {
    mockFetchMyRole.mockResolvedValue({ role: "MODERATOR", isAdmin: false, capabilities: [capability] });
    renderSettings();
    const allowed = capability === "appeals_review" ? "Review appeals" : "Review feedback";
    const refused = capability === "appeals_review" ? "Review feedback" : "Review appeals";
    const link = await screen.findByRole("link", { name: allowed });
    expect(link.getAttribute("href")).toBe(`/settings/moderation/${capability === "appeals_review" ? "appeals" : "feedback"}`);
    expect(screen.queryByRole("link", { name: refused })).toBeNull();
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
  });
  it("drops previous staff entries immediately when the signed-in account changes", async () => {
    let resolveOld!: (value: unknown) => void;
    const admin = { role: "ADMIN", isAdmin: true, capabilities: [] };
    mockFetchMyRole.mockResolvedValueOnce(admin)
      .mockReturnValueOnce(new Promise((done) => { resolveOld = done; }))
      .mockResolvedValueOnce({ role: null, isAdmin: false, capabilities: [] });
    const { rerender } = render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByRole("link", { name: "Review reports" });
    viewer.id = "u2";
    rerender(<MemoryRouter><Settings /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "Review reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalledTimes(2));
    viewer.id = "u3";
    rerender(<MemoryRouter><Settings /></MemoryRouter>);
    resolveOld(admin);
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("link", { name: "Review reports" })).toBeNull();
  });

  it("offers review to a permitted moderator without exposing team administration", async () => {
    mockFetchMyRole.mockResolvedValue({ role: "MODERATOR", isAdmin: false, capabilities: ["reports_review"] });
    renderSettings();
    const row = await screen.findByRole("link", { name: "Review reports" });
    expect(row.getAttribute("href")).toBe("/settings/moderation/queue");
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
  });

  it("does not offer report review to a moderator without that capability", async () => {
    mockFetchMyRole.mockResolvedValue({ role: "MODERATOR", isAdmin: false, capabilities: ["feedback_review"] });
    renderSettings();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Review reports" })).toBeNull();
  });

  it("offers report review to ADMIN even without an enumerated capability list", async () => {
    mockFetchMyRole.mockResolvedValue({ role: "ADMIN", isAdmin: true, capabilities: [] });
    renderSettings();
    expect(await screen.findByRole("link", { name: "Review reports" })).toBeTruthy();
  });

  it("is hidden from an ordinary reader", async () => {
    renderSettings();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
    expect(screen.queryByRole("region", { name: "Moderation" })).toBeNull();
  });

  it("is shown to an admin, pointing at the team console", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "ADMIN",
      isAdmin: true,
      capabilities: ["reports_review", "audit_read"],
    });
    renderSettings();
    const row = await screen.findByRole("link", { name: /team & permissions/i });
    expect(row.getAttribute("href")).toBe("/settings/team");
  });

  it("is hidden from a moderator, whose destinations are admin-only", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["reports_review"],
    });
    renderSettings();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
  });

  it("stays hidden when the role cannot be read", async () => {
    mockFetchMyRole.mockRejectedValue(new Error("offline"));
    renderSettings();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /team & permissions/i })).toBeNull();
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
  // Vitest may run from the repo root or apps/mobile — resolve by trial so
  // the guard holds in both. A total miss throws, failing loudly.
  function readMobileFile(relativePath: string): string {
    for (const candidate of [`apps/mobile/src/${relativePath}`, `src/${relativePath}`]) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        // Not under this cwd — try the next candidate.
      }
    }
    throw new Error(`cannot locate ${relativePath} from cwd ${process.cwd()}`);
  }
  const sharedCss = readMobileFile("components/settings/settings.css");
  const rootCss = readMobileFile("screens/Settings.css");

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
