// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { AiModels, assistantModeKey, computeProviderPricingUnknown } from "./AiModels";
import type { ModelRecord } from "../services/ai/providerContract";
import { SUPPORTED_AI_PROVIDERS } from "../services/aiCredentials";

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

const PAID_ROW: ModelRecord = {
  provider: "groq",
  id: "groq/paid-model",
  input: ["text"],
  output: ["text"],
  prices: [
    { amountDecimal: "0.5", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
  ],
  priceClass: "paid",
  retrievedAt: "2026-09-26T00:00:00.000Z",
  entitlement: "untested",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderModels(extra: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <AiModels accountId="u1" listCatalog={async () => [FREE_ROW, PAID_ROW]} {...extra} />
    </MemoryRouter>,
  );
}

describe("AiModels control center (AI-022)", () => {
  it("renders assistant modes, honest offline status, one card per vault slot, and the price-visible catalogue", async () => {
    renderModels();
    expect(screen.getByRole("radiogroup", { name: /assistant mode/i })).toBeTruthy();
    // Beta scope: only the two modes this build can honor are selectable.
    for (const label of ["Auto", "Cloud-only"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeTruthy();
    }
    for (const label of ["Offline-first", "Offline-only"]) {
      expect(screen.queryByRole("radio", { name: new RegExp(label) })).toBeNull();
    }
    // Offline modes are shown as an informational, non-actionable note.
    expect(screen.getByTestId("ai-offline-mode-note").textContent).toMatch(
      /not available in this build yet/i,
    );
    // Offline honesty: the registry seam stays unwired until the native bridge lands.
    expect(screen.getByTestId("ai-offline-status").textContent).toMatch(/not available/i);
    await screen.findByTestId("ai-provider-openai");
    for (const provider of SUPPORTED_AI_PROVIDERS) {
      expect(screen.getByTestId(`ai-provider-${provider}`)).toBeTruthy();
    }
    // Price/capability visibility comes from catalogue records, never invented here.
    await waitFor(() => expect(screen.getByText("openrouter/free")).toBeTruthy());
    expect(screen.getByText("groq/paid-model")).toBeTruthy();
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
    // Defaults + fallback policy view.
    expect(screen.getByText(/default route: openrouter\/free/i)).toBeTruthy();
  });

  it("persists the assistant mode per account and restores it", async () => {
    renderModels();
    const cloudOnly = screen.getByRole("radio", { name: /cloud-only/i });
    fireEvent.click(cloudOnly);
    expect(window.localStorage.getItem(assistantModeKey("u1"))).toBe("cloud-only");
    expect(cloudOnly.getAttribute("aria-checked")).toBe("true");
    cleanup();
    renderModels();
    expect(
      screen.getByRole("radio", { name: /cloud-only/i }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("surfaces a stored offline mode as unavailable without silently relaxing it", async () => {
    window.localStorage.setItem(assistantModeKey("u1"), "offline-only");
    renderModels();
    expect(screen.getByTestId("ai-offline-mode-active").textContent).toMatch(/not\s+available/i);
    // The privacy choice is preserved, never rewritten to a network mode.
    expect(window.localStorage.getItem(assistantModeKey("u1"))).toBe("offline-only");
    expect(screen.queryByRole("radio", { name: /cloud-only/i })?.getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("treats OpenAI and DeepSeek as ordinary BYOK providers with a Manage link", async () => {
    renderModels();
    const openaiCard = await screen.findByTestId("ai-provider-openai");
    expect(openaiCard.textContent).not.toMatch(/server relay/i);
    expect(within(openaiCard).getByRole("link", { name: /manage openai key/i })).toBeTruthy();
    expect(within(openaiCard).getByRole("button", { name: /^test$/i })).toBeTruthy();
    const deepseekCard = screen.getByTestId("ai-provider-deepseek");
    expect(deepseekCard.textContent).not.toMatch(/server relay/i);
    expect(within(deepseekCard).getByRole("link", { name: /manage deepseek key/i })).toBeTruthy();
  });

  it("shows vault connection state with masked tails only", async () => {
    renderModels();
    await waitFor(() => expect(screen.getByText("openrouter/free")).toBeTruthy());
    // No slot is connected in a fresh jsdom vault; every card says so honestly.
    const openrouterCard = screen.getByTestId("ai-provider-openrouter");
    expect(openrouterCard.textContent).toMatch(/not connected/i);
    expect(openrouterCard.textContent).not.toMatch(/sk-/);
    // OpenRouter is the one live-verified provider; everything else is Experimental.
    expect(screen.queryByTestId("ai-provider-experimental-openrouter")).toBeNull();
    expect(screen.getByTestId("ai-provider-experimental-groq")).toBeTruthy();
  });

  it("flags a provider whose whole catalogue is unknown-priced", () => {
    const unknown: ModelRecord = { ...PAID_ROW, provider: "xai", id: "xai/unknown", priceClass: "unknown" };
    expect(computeProviderPricingUnknown([unknown])).toMatchObject({ xai: true, groq: false, openrouter: false });
    expect(computeProviderPricingUnknown([FREE_ROW, PAID_ROW])).toMatchObject({
      openrouter: false,
      groq: false,
    });
    expect(computeProviderPricingUnknown([])).toMatchObject({ xai: false });
  });
});
