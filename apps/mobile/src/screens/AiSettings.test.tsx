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
import { refuseHelpSend } from "./Help";
import type { ModelRecord } from "../services/ai/providerContract";
import {
  aiPreferencesKey,
  loadEffectiveAssistantMode,
  loadSeededAiPreferences,
} from "../services/ai/aiPreferences";

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

const FREE_ROW: ModelRecord = {
  provider: "openrouter",
  id: "openrouter/free",
  input: ["text"],
  output: ["text"],
  prices: [
    { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
    { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
  ],
  priceClass: "free",
  retrievedAt: "2026-09-26T00:00:00.000Z",
  entitlement: "untested",
};

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

  it("binds AI mode to the single authoritative aiPreferences store with honest options only", () => {
    renderSettings();
    const group = screen.getByRole("radiogroup", { name: /ai mode/i });
    expect(group).toBeTruthy();
    // Only options this build can honor.
    expect(screen.getByRole("radio", { name: /automatic/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /on-device only/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /cloud only/i })).toBeTruthy();
    // Default with no stored preference.
    expect(
      (screen.getByRole("radio", { name: /automatic/i }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /on-device only/i }));
    expect(loadSeededAiPreferences("user-1").assistantMode).toBe("on-device-only");
    // The legacy key is migration-source only: no new writes land there.
    expect(globalThis.localStorage?.getItem("findback.ai.assistantMode.v1.user-1")).toBeNull();
    expect(
      (screen.getByRole("radio", { name: /on-device only/i }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("migrates a legacy stored offline-first mode fail-closed to offered on-device-only", () => {
    globalThis.localStorage?.setItem("findback.ai.assistantMode.v1.user-1", "offline-first");
    renderSettings();
    // Migrated (fail closed) to the offered on-device-only option — checked.
    expect(
      (screen.getByRole("radio", { name: /on-device only/i }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(loadSeededAiPreferences("user-1").assistantMode).toBe("on-device-only");
  });

  it("changing mode in AiSettings is observed by the Help send-gate (single store)", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: /on-device only/i }));
    // The exact reader Help uses at send time sees the AiSettings write.
    expect(loadEffectiveAssistantMode("user-1")).toBe("offline-only");
    // …and the actual send-gate refuses cloud rows for it (nothing sent).
    expect(
      refuseHelpSend({
        provider: "openrouter",
        record: FREE_ROW,
        mode: loadEffectiveAssistantMode("user-1"),
        hasImages: false,
      }),
    ).toMatch(/offline-only mode/i);
    fireEvent.click(screen.getByRole("radio", { name: /cloud only/i }));
    expect(loadEffectiveAssistantMode("user-1")).toBe("cloud-only");
    expect(
      refuseHelpSend({
        provider: "offline",
        record: null,
        mode: loadEffectiveAssistantMode("user-1"),
        hasImages: false,
      }),
    ).toMatch(/cloud-only mode/i);
    // A sibling account still reads the safe default (per-account isolation).
    expect(loadEffectiveAssistantMode("user-2")).toBe("auto");
    expect(globalThis.localStorage?.getItem(aiPreferencesKey("user-2"))).toBeNull();
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
