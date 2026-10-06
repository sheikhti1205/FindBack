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

import { AiModels, applyMatchesEngineToRuntime, assistantModeKey, computeProviderPricingUnknown } from "./AiModels";
import { aiPreferencesKey, loadAiPreferences } from "../services/ai/aiPreferences";
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

function renderModels(extra: Record<string, unknown> = {}, experimental = true) {
  if (experimental) localStorage.setItem("findback.ai.experimentalProviders.v1.u1", "true");
  return render(
    <MemoryRouter>
      <AiModels accountId="u1" listCatalog={async () => [FREE_ROW, PAID_ROW]} {...extra} />
    </MemoryRouter>,
  );
}

describe("AiModels control center (AI-022)", () => {
  it("offers all three truthful modes and keeps unproven remote providers off by default", async () => {
    renderModels({}, false);
    expect(screen.getByRole("radio", { name: /on-device only/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /automatic/i })).toBeTruthy();
    await screen.findByTestId("ai-provider-openrouter");
    expect(screen.queryByTestId("ai-provider-openai")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experimental providers" }));
    expect(await screen.findByTestId("ai-provider-openai")).toBeTruthy();
    expect(screen.queryByText(/offline-first remains hidden/i)).toBeNull();
  });
  it("renders assistant modes, honest offline status, one card per vault slot, and the price-visible catalogue", async () => {
    renderModels();
    expect(screen.getByRole("radiogroup", { name: /assistant mode/i })).toBeTruthy();
    for (const label of ["Automatic", "On-device only", "Cloud only"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeTruthy();
    }
    for (const label of ["Offline-first", "Offline-only"]) {
      expect(screen.queryByRole("radio", { name: new RegExp(label) })).toBeNull();
    }
    // Platform requirements are still disclosed alongside usable mode controls.
    expect(screen.getByTestId("ai-offline-mode-note").textContent).toMatch(
      /requires the Android app.*checksum-verified/i,
    );
    // Web offline honesty: no native bridge may be invoked here.
    expect(screen.getByTestId("ai-offline-status").textContent).toMatch(/requires the android app/i);
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

  it("persists the assistant mode per account in the authoritative store (no legacy writes)", async () => {
    renderModels();
    const cloudOnly = screen.getByRole("radio", { name: /cloud only/i });
    fireEvent.click(cloudOnly);
    expect(loadAiPreferences("u1").assistantMode).toBe("cloud-only");
    // The legacy key is migration-source only: choosing a mode must not
    // (re)write it.
    expect(window.localStorage.getItem(assistantModeKey("u1"))).toBeNull();
    expect(cloudOnly.getAttribute("aria-checked")).toBe("true");
    cleanup();
    renderModels();
    expect(
      screen.getByRole("radio", { name: /cloud only/i }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("surfaces a stored offline mode as unavailable without silently relaxing it", async () => {
    window.localStorage.setItem(assistantModeKey("u1"), "offline-only");
    renderModels();
    expect(screen.getByTestId("ai-offline-mode-active").textContent).toMatch(/not\s+available/i);
    // The privacy choice is preserved, never rewritten to a network mode.
    expect(window.localStorage.getItem(assistantModeKey("u1"))).toBe("offline-only");
    expect(screen.queryByRole("radio", { name: /cloud only/i })?.getAttribute("aria-checked")).toBe(
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

  it("owns Lane A assistant defaults: Automatic safe defaults, per-account persistence", async () => {
    renderModels();
    const modelSelect = screen.getByLabelText("Assistant default model") as HTMLSelectElement;
    const photoSelect = screen.getByLabelText("Photo engine") as HTMLSelectElement;
    const matchesSelect = screen.getByLabelText("Matches engine") as HTMLSelectElement;
    // Safe defaults: Automatic (null), automatic photo engine, use matches.
    expect(modelSelect.value).toBe("automatic");
    expect(photoSelect.value).toBe("automatic");
    expect(matchesSelect.value).toBe("use");
    // Only free rows are offered as the persisted default — paid never is.
    expect(modelSelect.textContent).toContain("openrouter/free");
    expect(modelSelect.textContent).not.toContain("groq/paid-model");
    // Needle stays locked without installed/verified evidence.
    const needleOption = within(matchesSelect).getByText(/needle/i) as HTMLOptionElement;
    expect(needleOption.disabled).toBe(true);
    // Persist choices for exactly this account (after the catalogue rows load).
    await waitFor(() => {
      const values = Array.from(modelSelect.querySelectorAll("option")).map((o) => o.value);
      expect(values).toContain("openrouter/free");
    });
    fireEvent.change(photoSelect, { target: { value: "cloud-only" } });
    fireEvent.change(modelSelect, { target: { value: "openrouter/free" } });
    expect(loadAiPreferences("u1").photoEngine).toBe("cloud-only");
    expect(loadAiPreferences("u1").preferredAssistantModel).toBe("openrouter/free");
    expect(window.localStorage.getItem(aiPreferencesKey("u2"))).toBeNull();
    await screen.findByTestId("ai-provider-openai");
  });

  it("unlocks the needle matches engine only with installed/verified evidence", () => {
    renderModels({
      needleEvidence: { measured: true, correctnessPass: true, fresh: true },
    });
    const matchesSelect = screen.getByLabelText("Matches engine") as HTMLSelectElement;
    const needleOption = within(matchesSelect).getByText(/needle/i) as HTMLOptionElement;
    expect(needleOption.disabled).toBe(false);
    fireEvent.change(matchesSelect, { target: { value: "needle" } });
    expect(loadAiPreferences("u1").matchesEngine).toBe("needle");
  });

  it("seeds the preference assistant mode once from a legacy stored mode", () => {
    window.localStorage.setItem(assistantModeKey("u1"), "cloud-only");
    renderModels();
    expect(loadAiPreferences("u1").assistantMode).toBe("cloud-only");
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

  it("applies the matches engine to the live runtime, failing closed off-device", () => {
    // "use" always applies (the safe default, no native requirement).
    expect(applyMatchesEngineToRuntime("use")).toBe(true);
    // "needle" needs Android + an installed model: in jsdom it must fail
    // closed (false, never throw) so the caller can say so honestly.
    expect(applyMatchesEngineToRuntime("needle")).toBe(false);
    expect(applyMatchesEngineToRuntime("use")).toBe(true);
  });
});
