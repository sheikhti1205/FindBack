// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  currentUserId: "user-1" as string | null,
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: mocks.currentUserId ? { id: mocks.currentUserId } : null }),
}));
vi.mock("../services/aiCredentials", () => ({
  aiCredentials: { get: mocks.get },
}));

import { AiSettings } from "./AiSettings";
import { assistantModeKey } from "./AiModels";

const FORBIDDEN = [
  "checksum",
  "runtime",
  "backend",
  "transport",
  "schema",
  "device_required",
  "challenger",
  "fresh passing measurement",
  "device required",
];

function expectNormalTierCopy(container: HTMLElement) {
  const text = (container.textContent ?? "").toLowerCase();
  for (const term of FORBIDDEN) {
    expect(text).not.toContain(term);
  }
  expect(text).not.toMatch(/[0-9a-f]{16,}/);
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <AiSettings />
    </MemoryRouter>,
  );
}

describe("AiSettings consumer root", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = "user-1";
    mocks.get.mockResolvedValue(null);
    globalThis.localStorage?.clear();
  });
  afterEach(cleanup);

  it("renders one h1 with rows to the AI sections and back to settings", async () => {
    const view = renderSettings();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /ai & intelligence/i,
    );
    expect(screen.getByRole("link", { name: /on-device ai/i }).getAttribute("href")).toBe(
      "/settings/ai/models",
    );
    expect(screen.getByRole("link", { name: /cloud connections/i }).getAttribute("href")).toBe(
      "/settings/ai/connections",
    );
    expect(screen.getByRole("link", { name: /advanced/i }).getAttribute("href")).toBe(
      "/settings/ai/advanced",
    );
    expect(screen.getByRole("button", { name: /back to settings/i })).toBeTruthy();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await screen.findByText(/openrouter/i);
    expectNormalTierCopy(view.container);
  });

  it("binds AI mode to the real assistant-mode store with honest options only", () => {
    renderSettings();
    const group = screen.getByRole("radiogroup", { name: /ai mode/i });
    expect(group).toBeTruthy();
    // Only options this build can honor; offline-first stays hidden.
    expect(screen.getByRole("radio", { name: /automatic/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /on-device only/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /cloud only/i })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /offline-first/i })).toBeNull();
    // Default with no stored preference.
    expect(
      (screen.getByRole("radio", { name: /automatic/i }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /on-device only/i }));
    expect(globalThis.localStorage?.getItem(assistantModeKey("user-1"))).toBe("offline-only");
    expect(
      (screen.getByRole("radio", { name: /on-device only/i }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("keeps a stored offline-first mode without offering it", () => {
    globalThis.localStorage?.setItem(assistantModeKey("user-1"), "offline-first");
    renderSettings();
    expect(screen.queryByRole("radio", { name: /offline-first/i })).toBeNull();
    expect(screen.getByText(/offline-first is set/i)).toBeTruthy();
    // The hidden stored value is never silently relaxed.
    expect(globalThis.localStorage?.getItem(assistantModeKey("user-1"))).toBe("offline-first");
  });

  it("summarizes the cloud connection without technical detail", async () => {
    mocks.get.mockResolvedValue("sk-or-v1-abcdefgh1234");
    const view = renderSettings();
    await waitFor(() => expect(screen.getByText(/openrouter connected/i)).toBeTruthy());
    expect(view.container.textContent).not.toContain("sk-or-v1-abcdefgh1234");
    expectNormalTierCopy(view.container);
  });

  it("shows not connected when no provider key is saved", async () => {
    mocks.get.mockResolvedValue(null);
    renderSettings();
    await waitFor(() => expect(screen.getByText(/openrouter not connected/i)).toBeTruthy());
  });
});
