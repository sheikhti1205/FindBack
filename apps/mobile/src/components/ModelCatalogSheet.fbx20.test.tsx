// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ModelCatalogSheet } from "./ModelCatalogSheet";
import type { ModelRecord } from "../services/ai/providerContract";
import { SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";

afterEach(() => {
  cleanup();
});

function record(overrides: Partial<ModelRecord> & Pick<ModelRecord, "provider" | "id">): ModelRecord {
  return {
    displayName: `Test model ${overrides.id}`,
    qualifiedRoles: ["chat"],
    input: ["text"],
    output: ["text"],
    prices: [],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "untested",
    ...overrides,
  };
}

function renderAssistant(models: readonly ModelRecord[]) {
  render(
    <MemoryRouter>
      <ModelCatalogSheet variant="assistant" models={models} selectedId={null} onSelect={() => {}} onSelectAutomatic={() => {}} />
    </MemoryRouter>,
  );
}

describe("ModelCatalogSheet assistant picker FBX-020 (models lead, provider is metadata)", () => {
  it("lists model names with the provider as secondary metadata", () => {
    renderAssistant([
      record({ provider: "openrouter", id: "openrouter/free", displayName: "Free model router" }),
      record({ provider: "groq", id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B" }),
    ]);
    expect(screen.getByText("Free model router")).toBeTruthy();
    expect(screen.getByText("Llama 3.3 70B")).toBeTruthy();
    // Provider is metadata under the model — never a flat row of its own.
    expect(screen.getByTestId("model-provider-openrouter").textContent).toMatch(/via OpenRouter/);
    expect(screen.getByTestId("model-provider-groq").textContent).toMatch(/via Groq/);
  });

  it("never shows a raw engine id as a model title", () => {
    renderAssistant([
      {
        provider: "offline",
        id: SMOL_VISION_MODEL_ID,
        qualifiedRoles: ["vision"],
        input: ["text", "image"],
        output: ["text"],
        prices: [],
        priceClass: "free",
        retrievedAt: "2026-09-26T00:00:00.000Z",
        entitlement: "untested",
      },
    ]);
    expect(screen.queryByText("SmolVLM2")).toBeNull();
    // The consumer vision title leads; On-device is the locality metadata.
    expect(screen.getByText("Photo analysis")).toBeTruthy();
    expect(screen.getByTestId("model-provider-offline").textContent).toMatch(/via On-device/);
  });

  it("never lists providers or the Automatic choice as flat model rows", () => {
    renderAssistant([
      record({ provider: "openrouter", id: "openrouter/free", displayName: "Free model router" }),
      record({ provider: "mistral", id: "mistral-small-latest", displayName: "Mistral Small" }),
    ]);
    const rows = screen.getAllByRole("button", { name: /select/i });
    const labels = rows.map((row) => row.textContent ?? "");
    for (const banned of ["OpenRouter", "Groq", "Mistral", "Automatic", "Generic"]) {
      expect(labels.some((label) => label.trim() === banned)).toBe(false);
    }
  });
});
