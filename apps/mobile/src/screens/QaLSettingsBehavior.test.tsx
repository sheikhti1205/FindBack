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
import { toConsumerNotice } from "./AiModelsRoute";
import { aiModeSummary } from "./Settings";

/* ------------------------------------------------------------------ */
/* 1. Search index against packet matrix settings_search_index.csv      */
/* ------------------------------------------------------------------ */

const SEARCH_MATRIX: ReadonlyArray<{ title: string; keywords: string; route: string }> = [
  { title: "Account & profile", keywords: "profile username email phone avatar", route: "/settings/account" },
  { title: "Appearance", keywords: "theme dark amoled accent color personalization", route: "/settings/appearance" },
  { title: "Accessibility", keywords: "font text size motion reduce animation", route: "/settings/accessibility" },
  { title: "Media & uploads", keywords: "photo image quality data storage upload", route: "/settings/media" },
  { title: "Notifications", keywords: "push comment mention like status report bell", route: "/settings/notifications" },
  { title: "AI & models", keywords: "ai local offline model automatic cpu gpu cloud", route: "/settings/ai" },
  { title: "Cloud connections", keywords: "openrouter api key provider openai google mistral groq", route: "/settings/ai/connections" },
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
  useTheme: () => ({ theme: "amoled", setTheme: vi.fn() }),
}));

vi.mock("../services/notificationPreferences", () => ({
  fetchNotificationPreferences: (...args: unknown[]) => mockFetchPrefs(...args),
}));

vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({ permission: (...args: unknown[]) => mockPermission(...args) }),
}));

vi.mock("../services/aiCredentials", () => ({
  aiCredentials: { hasSaved: (...args: unknown[]) => mockHasSaved(...args) },
}));

import { assistantModeKey } from "./AiModels";
import { Settings } from "./Settings";
import { AccountSettings } from "./AccountSettings";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="probe">{`${location.pathname}${location.search}`}</p>;
}

const SETTINGS_TARGETS = [
  "/settings/account",
  "/settings/appearance",
  "/settings/accessibility",
  "/settings/media",
  "/settings/notifications",
  "/settings/ai",
  "/settings/ai/connections",
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

describe("QA L: AI & models summary is live, not hard-coded", () => {
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

  it("maps stored assistant modes to truthful labels", () => {
    expect(aiModeSummary("auto")).toBe("Automatic");
    expect(aiModeSummary("offline-only")).toBe("On-device only");
    expect(aiModeSummary("cloud-only")).toBe("Cloud only");
    expect(aiModeSummary("offline-first")).toBe("Offline-first");
  });

  it("shows Automatic when no mode is stored", async () => {
    renderSettings();
    const row = await screen.findByRole("link", { name: /AI & models/ });
    expect(row.textContent).toContain("Automatic");
  });

  it("shows the stored mode instead of a hard-coded value", async () => {
    localStorage.setItem(assistantModeKey("u1"), "cloud-only");
    renderSettings();
    const row = await screen.findByRole("link", { name: /AI & models/ });
    expect(row.textContent).toContain("Cloud only");
    expect(row.textContent).not.toMatch(/Automatic/);
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
      toConsumerNotice("Installed and checksum verified."),
      toConsumerNotice("checksum mismatch against catalogue pin"),
      toConsumerNotice("no catalogue checksum pin for this model"),
      toConsumerNotice("checksum verification failed"),
      toConsumerNotice("transfer failed"),
      toConsumerNotice("not enough free storage for this download"),
      toConsumerNotice("downloads start only on explicit user action"),
      toConsumerNotice("model installed"),
      toConsumerNotice("unknown model smolvlm2-q4"),
      toConsumerNotice("Model storage could not be verified. Retry from AI & Models."),
    ];
    for (const output of outputs) {
      expect(output ?? "").not.toMatch(/checksum|sha|catalogue|unknown model \S+|transfer/i);
    }
  });

  it("keeps friendly consumer wording for storage and verification outcomes", () => {
    expect(toConsumerNotice("not enough free storage for this download")).toContain("storage");
    expect(toConsumerNotice("checksum mismatch against catalogue pin")).toMatch(/verif/i);
  });
});
