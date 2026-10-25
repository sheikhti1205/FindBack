// @vitest-environment jsdom
/**
 * QA L — settings behavior audit (binding brief qa-L-brief.md).
 *
 * Every row proves a real route or real state effect in jsdom; the search
 * index is run against packet matrices/settings_search_index.csv; live
 * summaries must be truthful; every backTo must land on a mounted route.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchSettings } from "../services/settingsIndex";
import { localOperationNotice } from "../services/ai/localIntelligenceView";

/* ------------------------------------------------------------------ */
/* 1. Search index against packet matrix settings_search_index.csv      */
/* ------------------------------------------------------------------ */

const SEARCH_MATRIX: ReadonlyArray<{ title: string; keywords: string; route: string }> = [
  { title: "Account & profile", keywords: "profile username email phone avatar", route: "/settings/account" },
  { title: "Appearance", keywords: "theme dark amoled accent color personalization", route: "/settings/appearance" },
  { title: "Accessibility", keywords: "font text size motion reduce animation", route: "/settings/accessibility" },
  { title: "Media & uploads", keywords: "photo image quality data storage upload", route: "/settings/media" },
  { title: "Notifications", keywords: "push comment mention like status report bell", route: "/settings/notifications" },
  { title: "AI & models", keywords: "ai local on device model cloud chat providers", route: "/settings/ai" },
  { title: "Providers", keywords: "providers cloud connections openrouter api key provider openai google mistral groq", route: "/settings/ai/connections" },
  { title: "Privacy & permissions", keywords: "privacy location permission sharing", route: "/settings/privacy" },
  { title: "Diagnostics", keywords: "debug build logs export support", route: "/settings/diagnostics" },
  { title: "Help & guide", keywords: "faq tutorial onboarding lost found search recover", route: "/settings/help" },
  { title: "About FindBack", keywords: "version build application", route: "/settings/about" },
];

describe("QA L: settings search index resolves every packet alias", () => {
  it.each(SEARCH_MATRIX)("aliases for $title resolve to $route", ({ title, keywords, route }) => {
    const byKeywords = searchSettings(keywords).map((entry) => String(entry.route));
    expect(byKeywords).toContain(route);
    const byTitle = searchSettings(title).map((entry) => String(entry.route));
    expect(byTitle).toContain(route);
    for (const token of keywords.split(" ")) {
      const byToken = searchSettings(token).map((entry) => String(entry.route));
      expect(byToken).toContain(route);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Settings root rows navigate to real routes (click proving)       */
/* ------------------------------------------------------------------ */

const { mockLogout, mockFetchPrefs, mockPermission, mockHasSaved } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockFetchPrefs: vi.fn(),
  mockPermission: vi.fn(),
  mockHasSaved: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
      email: "tester@example.com",
      phone: "+8801000000000",
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

vi.mock("../services/aiCredentials", () => ({
  aiCredentials: {
    hasSaved: (...args: unknown[]) => mockHasSaved(...args),
    get: async (...args: unknown[]) => ((await mockHasSaved(...args)) ? "k" : null),
  },
  describeCloudConnections: async (...args: unknown[]) => {
    const has = await mockHasSaved(...args);
    return { summary: has ? "OpenRouter connected" : "Not connected", providers: [] };
  },
}));

import { assistantModeKey } from "./AiModels";
import { Settings } from "./Settings";
import { AccountSettings } from "./AccountSettings";
import { AiSettings } from "./AiSettings";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="probe">{`${location.pathname}${location.search}`}</p>;
}

const SETTINGS_TARGETS = [
  "/settings/account",
  "/settings/appearance",
  "/settings/accessibility",
  "/settings/feed-layout",
  "/settings/media",
  "/settings/notifications",
  "/settings/ai",
  // "/settings/ai/connections" moved inside AI & models (W4) — covered by the
  // through-AI navigation test below, not as a root row.
  "/settings/privacy",
  "/settings/diagnostics",
  "/settings/help",
  "/onboarding?replay=1",
  "/settings/about",
] as const;

describe("QA L: every settings row click lands on its route", () => {
  beforeEach(() => {
    mockFetchPrefs.mockResolvedValue({ pushEnabled: true });
    mockHasSaved.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each(SETTINGS_TARGETS)("row click navigates to %s", async (target) => {
    const [path] = target.split("?");
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path={path} element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const anchor = anchors.find((a) => a.getAttribute("href") === target);
    expect(anchor, `row linking to ${target} exists`).toBeDefined();
    fireEvent.click(anchor!);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe(target);
    });
  });
});

describe("QA L: Providers stays reachable through AI & models", () => {
  beforeEach(() => {
    mockFetchPrefs.mockResolvedValue({ pushEnabled: true });
    mockHasSaved.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("root → AI & models → Providers lands on its route", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/ai" element={<AiSettings />} />
          <Route path="/settings/ai/connections" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /AI & models/ }));
    const cloudRow = await screen.findByRole("link", { name: /^providers$/i });
    expect(cloudRow.getAttribute("href")).toBe("/settings/ai/connections");
    fireEvent.click(cloudRow);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("/settings/ai/connections");
    });
  });
});

describe("QA L: AI & models row shows no retired mode value", () => {
  beforeEach(() => {
    mockFetchPrefs.mockResolvedValue({ pushEnabled: true });
    mockHasSaved.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  function renderSettings() {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("never offers the retired Automatic/Offline-first/Cloud-only mode vocabulary", async () => {
    // A stored legacy mode (even a fail-closed migrated one) must not leak
    // back into the root row: Chat is cloud-only and has no mode switch.
    localStorage.setItem(assistantModeKey("u1"), "offline-first");
    renderSettings();
    const row = await screen.findByRole("link", { name: /AI & models/ });
    expect(row.textContent).not.toMatch(/Automatic|Offline-first|On-device only|Cloud only/);
  });

  it("describes what the AI row leads to instead of a mode label", async () => {
    renderSettings();
    const row = await screen.findByRole("link", { name: /AI & models/ });
    expect(row.textContent).toMatch(/cloud chat/i);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Account sign-out carries loading AND error semantics              */
/* ------------------------------------------------------------------ */

describe("QA L: account sign-out surfaces failures instead of swallowing them", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderAccount() {
    render(
      <MemoryRouter initialEntries={["/settings/account"]}>
        <Routes>
          <Route path="/settings/account" element={<AccountSettings />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("shows a loading state while logging out", async () => {
    let release!: () => void;
    mockLogout.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    const busy = screen.getByRole("button", { name: /log out/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    release();
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /log out/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("announces a logout failure instead of failing silently", async () => {
    mockLogout.mockRejectedValueOnce(new Error("network down"));
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not|log out|try again/i);
    expect((screen.getByRole("button", { name: /log out/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Normal-tier notice translation: no raw checksum/enum leaks        */
/* ------------------------------------------------------------------ */

describe("QA L: normal-tier notices never leak technical wording", () => {
  it("translates every known service reason to consumer copy", () => {
    const outputs = [
      localOperationNotice("Installed and checksum verified."),
      localOperationNotice("checksum mismatch against catalogue pin"),
      localOperationNotice("no catalogue checksum pin for this model"),
      localOperationNotice("checksum verification failed"),
      localOperationNotice("transfer failed"),
      localOperationNotice("not enough free storage for this download"),
      localOperationNotice("downloads start only on explicit user action"),
      localOperationNotice("model installed"),
      localOperationNotice("unknown model smolvlm2-q4"),
      localOperationNotice("Model storage could not be verified. Retry from AI & Models."),
    ];
    for (const output of outputs) {
      expect(output ?? "").not.toMatch(/checksum|sha|catalogue|unknown model \S+|transfer/i);
    }
  });

  it("keeps friendly consumer wording for storage and verification outcomes", () => {
    expect(localOperationNotice("not enough free storage for this download")).toBe("Free some space on this device, then try again.");
    expect(localOperationNotice("checksum mismatch against catalogue pin")).toBe("The downloaded file couldn't be checked. Download it again.");
    expect(localOperationNotice("Installed and checksum verified.")).toBeNull();
    expect(localOperationNotice("native /data/files/private unknown-model ABI")).toBe("Couldn't finish. Please try again.");
  });
});

/* ------------------------------------------------------------------ */
/* 5. W4 root IA: five groups, moved rows nested but reachable           */
/* ------------------------------------------------------------------ */

describe("QA L: W4 root groups moved rows without orphaning destinations", () => {
  beforeEach(() => {
    mockFetchPrefs.mockResolvedValue({ pushEnabled: true });
    mockHasSaved.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  function renderSettingsRoot() {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders the Account/Preferences/Intelligence/Privacy/More groups", () => {
    renderSettingsRoot();
    for (const name of ["Account", "Preferences", "Intelligence", "Privacy", "More"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("nests moved rows under the Advanced, Legal and Help & about disclosures", () => {
    renderSettingsRoot();
    const more = screen.getByRole("region", { name: "More" });
    // Three nested groups: Advanced (uploads/troubleshooting), Legal, Help &
    // about. The expectation said two and had been red on main since the Legal
    // group landed; the href assertions below were already the real contract.
    expect(more.querySelectorAll("details.fb-settings-nested")).toHaveLength(3);
    const hrefs = Array.from(document.querySelectorAll("a[href]")).map((a) =>
      (a as HTMLAnchorElement).getAttribute("href"),
    );
    for (const href of ["/settings/media", "/settings/diagnostics", "/settings/help", "/onboarding?replay=1", "/settings/about"]) {
      expect(hrefs, `nested row linking to ${href} exists`).toContain(href);
    }
  });

  it("shows the profile header linking to the existing profile edit route", () => {
    renderSettingsRoot();
    const header = screen.getByRole("link", { name: /edit profile/i });
    expect(header.getAttribute("href")).toBe("/profile/edit");
    expect(screen.getByText("@tester")).toBeTruthy();
  });
});
