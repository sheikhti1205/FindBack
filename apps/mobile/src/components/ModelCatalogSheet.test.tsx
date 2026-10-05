// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelCatalogSheet, matchesCatalogFilter } from "./ModelCatalogSheet";
import type { ModelRecord } from "../services/ai/providerContract";

afterEach(() => {
  cleanup();
});

function freeRecord(provider: ModelRecord["provider"], id: string): ModelRecord {
  return {
    provider,
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 128_000,
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "untested",
  };
}

const visionRecord: ModelRecord = {
  ...freeRecord("groq", "groq-vision"),
  input: ["text", "image"],
};

describe("ModelCatalogSheet filters (AI-024b)", () => {
  it("matches All/Free/Vision/Fast/Offline/provider predicates honestly", () => {
    expect(matchesCatalogFilter(visionRecord, { kind: "vision" })).toBe(true);
    expect(matchesCatalogFilter(visionRecord, { kind: "fast" })).toBe(false);
    expect(matchesCatalogFilter(freeRecord("groq", "a"), { kind: "fast" })).toBe(true);
    expect(matchesCatalogFilter(freeRecord("offline", "b"), { kind: "offline" })).toBe(true);
    expect(matchesCatalogFilter(freeRecord("groq", "a"), { kind: "offline" })).toBe(false);
    expect(matchesCatalogFilter(freeRecord("xai", "c"), { kind: "provider", provider: "xai" })).toBe(true);
    expect(matchesCatalogFilter(freeRecord("xai", "c"), { kind: "provider", provider: "groq" })).toBe(false);
  });

  it("filters rows by controlled filter and reports an empty filter honestly", () => {
    const { rerender } = render(
      <ModelCatalogSheet
        models={[freeRecord("groq", "a"), visionRecord]}
        onSelect={() => {}}
        activeFilter={{ kind: "vision" }}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^select$/i })).toHaveLength(1);
    rerender(
      <ModelCatalogSheet
        models={[freeRecord("groq", "a"), visionRecord]}
        onSelect={() => {}}
        activeFilter={{ kind: "offline" }}
      />,
    );
    expect(screen.getByText("No models match this filter.")).toBeTruthy();
    expect(screen.getByTestId("offline-status").textContent).toMatch(/requires the android app/i);
  });

  it("drives chips in uncontrolled mode", () => {
    render(<ModelCatalogSheet models={[freeRecord("groq", "a"), visionRecord]} onSelect={() => {}} />);
    const vision = screen.getByRole("button", { name: "Vision" });
    expect(vision.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(vision);
    expect(screen.getByRole("button", { name: "Vision" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "groq" }));
    expect(screen.getByRole("button", { name: "groq" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the seam-provided offline readiness copy and selects a row", () => {
    const onSelect = vi.fn();
    render(
      <ModelCatalogSheet
        models={[freeRecord("groq", "a"), freeRecord("groq", "b")]}
        onSelect={onSelect}
        offlineDetail="On-device AI requires the Android app."
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Offline" }));
    expect(screen.getByTestId("offline-status").textContent).toBe(
      "On-device AI requires the Android app.",
    );
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^select$/i })[1]!);
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
