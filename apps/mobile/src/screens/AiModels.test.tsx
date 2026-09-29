// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AiModels, assistantModeKey } from "./AiModels";
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
    for (const label of ["Auto", "Offline-first", "Offline-only", "Cloud-only"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeTruthy();
    }
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
    const offlineOnly = screen.getByRole("radio", { name: /offline-only/i });
    fireEvent.click(offlineOnly);
    expect(window.localStorage.getItem(assistantModeKey("u1"))).toBe("offline-only");
    expect(offlineOnly.getAttribute("aria-checked")).toBe("true");
    cleanup();
    renderModels();
    expect(
      screen.getByRole("radio", { name: /offline-only/i }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("probes relay providers without a vault key and reports readiness", async () => {
    const relayChat = vi.fn(async () => ({ text: "ok" }));
    renderModels({ relayChat });
    const openaiCard = await screen.findByTestId("ai-provider-openai");
    expect(openaiCard.textContent).toMatch(/server relay/i);
    const firstRelayTest = screen.getAllByRole("button", { name: /test relay/i }).at(0);
    expect(firstRelayTest).toBeTruthy();
    fireEvent.click(firstRelayTest as HTMLElement);
    await waitFor(() => expect(relayChat).toHaveBeenCalled());
    expect(relayChat.mock.calls.at(0)?.at(0)).toMatchObject({ provider: "openai" });
    await waitFor(() =>
      expect(openaiCard.textContent).toMatch(/relay ready for openai/i),
    );
  });

  it("shows vault connection state with masked tails only", async () => {
    renderModels();
    await waitFor(() => expect(screen.getByText("openrouter/free")).toBeTruthy());
    // No slot is connected in a fresh jsdom vault; every card says so honestly.
    const openrouterCard = screen.getByTestId("ai-provider-openrouter");
    expect(openrouterCard.textContent).toMatch(/not connected/i);
    expect(openrouterCard.textContent).not.toMatch(/sk-/);
  });
});
