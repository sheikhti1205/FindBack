// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout, mockFetchPrefs, mockPermission, mockDescribeCloudConnections } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockFetchPrefs: vi.fn(),
  mockPermission: vi.fn(),
  mockDescribeCloudConnections: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
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
  useTheme: () => ({ theme: "amoled", setTheme: vi.fn() }),
}));

vi.mock("../services/notificationPreferences", () => ({
  fetchNotificationPreferences: (...args: unknown[]) => mockFetchPrefs(...args),
}));

vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({ permission: (...args: unknown[]) => mockPermission(...args) }),
}));

vi.mock("../services/aiCredentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiCredentials")>();
  return {
    ...actual,
    describeCloudConnections: (...args: unknown[]) => mockDescribeCloudConnections(...args),
  };
});

import {
  accessibilitySummary,
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
  mockDescribeCloudConnections.mockResolvedValue({
    connected: true,
    count: 1,
    providers: ["openrouter"],
    summary: "OpenRouter connected",
  });
  mockLogout.mockResolvedValue(undefined);
});

function renderSettings() {
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

describe("summary helpers", () => {
  it("composes the appearance value from live theme and accent", () => {
    expect(appearanceSummary("amoled", "emerald")).toBe("AMOLED · Emerald");
    expect(appearanceSummary("system", "blue")).toBe("System · Blue");
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
  it("renders one h1, the search field, and the exact group structure", () => {
    renderSettings();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    for (const name of ["Personalization", "Activity", "AI & intelligence", "Privacy & app", "Support"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("links every row to its real route_map.csv target", () => {
    renderSettings();
    const expected: Array<[string, string]> = [
      ["Appearance", "/settings/appearance"],
      ["Accessibility", "/settings/accessibility"],
      ["Media & uploads", "/settings/media"],
      ["Notifications", "/settings/notifications"],
      ["AI & models", "/settings/ai"],
      ["Cloud connections", "/settings/ai/connections"],
      ["Privacy & permissions", "/settings/privacy"],
      ["Diagnostics", "/settings/diagnostics"],
      ["Help & guide", "/settings/help"],
      ["Replay introduction", "/onboarding?replay=1"],
      ["About FindBack", "/settings/about"],
    ];
    for (const [name, href] of expected) {
      const row = screen.getByRole("link", { name: new RegExp(name.replace(/&/g, "&")) });
      expect(row.getAttribute("href")).toBe(href);
    }
    const account = screen.getByRole("link", { name: /manage account/i });
    expect(account.getAttribute("href")).toBe("/settings/account");
  });

  it("shows live summary values and the account card", async () => {
    renderSettings();
    expect(await screen.findByText("AMOLED · Emerald")).toBeTruthy();
    expect(await screen.findByText("Default text · System motion")).toBeTruthy();
    expect(await screen.findByText("Standard")).toBeTruthy();
    expect(await screen.findByText("On")).toBeTruthy();
    expect(await screen.findByText("OpenRouter connected")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
  });

  it("shows honest fallbacks when live sources are unreadable", async () => {
    mockFetchPrefs.mockRejectedValueOnce(new Error("offline"));
    mockPermission.mockRejectedValueOnce(new Error("offline"));
    mockDescribeCloudConnections.mockRejectedValueOnce(new Error("offline"));
    renderSettings();
    expect(await screen.findByText("Review settings")).toBeTruthy();
    expect(await screen.findByText("Not connected")).toBeTruthy();
  });

  it("filters rows by alias terms and shows the verbatim empty state", async () => {
    renderSettings();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "theme" } });
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /appearance/i })).toBeTruthy();
    });
    expect(screen.queryByRole("region", { name: "Personalization" })).toBeNull();

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
    const group = screen.getByRole("region", { name: "Personalization" });
    for (const row of within(group).getAllByRole("link")) {
      expect(row.querySelectorAll("button,a,input").length).toBe(0);
    }
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

  it("renders a saved OpenRouter connection as connected", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 1,
      providers: ["openrouter"],
      summary: "OpenRouter connected",
    });
    renderSettings();
    expect(await screen.findByText("OpenRouter connected")).toBeTruthy();
    expect(mockDescribeCloudConnections).toHaveBeenCalledWith("u1");
  });

  it("renders a session-only OpenRouter connection as connected", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 1,
      providers: ["openrouter"],
      summary: "OpenRouter connected",
    });
    renderSettings();
    expect(await screen.findByText("OpenRouter connected")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("renders a non-default provider-only connection as connected", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 1,
      providers: ["openai"],
      summary: "OpenAI connected",
    });
    renderSettings();
    expect(await screen.findByText("OpenAI connected")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("renders multiple providers with a truthful summary", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 2,
      providers: ["openai", "anthropic"],
      summary: "2 connections",
    });
    renderSettings();
    expect(await screen.findByText("2 connections")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("renders no connections as not connected", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: false,
      count: 0,
      providers: [],
      summary: "Not connected",
    });
    renderSettings();
    expect(await screen.findByText("Not connected")).toBeTruthy();
  });

  it("queries the current account id (sibling-account isolation)", async () => {
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 1,
      providers: ["openai"],
      summary: "OpenAI connected",
    });
    renderSettings();
    expect(await screen.findByText("OpenAI connected")).toBeTruthy();
    expect(mockDescribeCloudConnections).toHaveBeenCalledWith("u1");
    expect(mockDescribeCloudConnections).not.toHaveBeenCalledWith("sibling-account");
  });

  it("never renders raw key material in the cloud row", async () => {
    const secret = "sk-live-F03-PROBE-SECRET-9f8e7d6c5b4a";
    mockDescribeCloudConnections.mockResolvedValueOnce({
      connected: true,
      count: 1,
      providers: ["openrouter"],
      summary: "OpenRouter connected",
    });
    const { container } = render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );
    expect(await screen.findByText("OpenRouter connected")).toBeTruthy();
    expect(container.textContent ?? "").not.toContain(secret);
    expect(JSON.stringify(mockDescribeCloudConnections.mock.results)).not.toContain(secret);
  });
});
