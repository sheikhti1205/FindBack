// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  // Retired vocabulary: the AI mode radio is gone with the cloud-only Chat.
  "on-device only",
  "cloud only",
  "offline-first",
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
    expect(screen.getByRole("link", { name: /^providers$/i }).getAttribute("href")).toBe(
      "/settings/ai/connections",
    );
    expect(screen.getByRole("link", { name: /^models$/i }).getAttribute("href")).toBe(
      "/settings/ai/chat-models",
    );
    expect(screen.getByRole("link", { name: /local intelligence/i }).getAttribute("href")).toBe(
      "/settings/local-intelligence",
    );
    expect(screen.queryByRole("link", { name: /on-device ai/i })).toBeNull();
    expect(screen.getByRole("button", { name: /back to settings/i })).toBeTruthy();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expectNormalTierCopy(view.container);
  });

  it("groups the rows by what the reader is choosing", () => {
    renderSettings();
    for (const name of ["AI Chat", "On this device"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    // The local download owner is reached from the local row, not from a
    // second competing "manage models" entry point.
    expect(screen.getAllByRole("link", { name: /local intelligence/i })).toHaveLength(1);
  });

  it("offers no AI mode switch: Chat is cloud-only, so the retired radio cannot come back", () => {
    renderSettings();
    expect(screen.queryByRole("radiogroup", { name: /ai mode/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /on-device only/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /cloud only/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /automatic/i })).toBeNull();
  });

  it("summarizes the cloud connection without technical detail", async () => {
    mocks.get.mockResolvedValue("sk-or-v1-abcdefgh1234");
    const view = renderSettings();
    await waitFor(() => expect(screen.getByText(/Connected\./)).toBeTruthy());
    expect(view.container.textContent).not.toContain("sk-or-v1-abcdefgh1234");
    expectNormalTierCopy(view.container);
  });

  it("shows not connected when no provider key is saved", async () => {
    mocks.get.mockResolvedValue(null);
    renderSettings();
    await waitFor(() => expect(screen.getByText(/No key saved yet\./)).toBeTruthy());
  });

  it("keeps the core features independent from any AI setup", async () => {
    mocks.get.mockResolvedValue(null);
    const view = renderSettings();
    await waitFor(() => expect(screen.getByText(/No key saved yet\./)).toBeTruthy());
    expect(view.container.textContent).toMatch(/core features work without any ai setup/i);
  });

  it("summarizes the provider Chat actually uses, and names it", async () => {
    // Ten providers hold their own keys, so the summary must read the slot of
    // the saved Chat model — not the default provider's slot.
    globalThis.localStorage.setItem(
      "findback.cloud.models.v1.user-1",
      JSON.stringify({ defaultModel: { provider: "anthropic", modelId: "claude-sonnet" }, favorites: [], lastUsed: [] }),
    );
    mocks.get.mockResolvedValue(null);
    renderSettings();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("user-1", "anthropic"));
    expect(screen.getByText(/Your Anthropic key for Chat\./)).toBeTruthy();
  });

  it("names no provider when there is no account to hold a key", async () => {
    // Signed out: OpenRouter is only the app's default route, not a choice
    // this reader made, so the row must not put it on screen.
    mocks.currentUserId = null;
    mocks.get.mockResolvedValue(null);
    const view = renderSettings();
    await waitFor(() => expect(screen.getByText(/Sign in to add a provider key for Chat\./)).toBeTruthy());
    expect(view.container.textContent).not.toMatch(/OpenRouter key/i);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
