// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ModelCatalogSheet, matchesCatalogFilter, matchesRoleFilter } from "./ModelCatalogSheet";
import type { ModelRecord } from "../services/ai/providerContract";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";

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

  it("matches capability roles per row for the library chips", () => {
    const needleRow = freeRecord("offline", NEEDLE_MODEL_ID);
    expect(matchesRoleFilter(needleRow, "all")).toBe(true);
    expect(matchesRoleFilter(needleRow, "tools")).toBe(true);
    expect(matchesRoleFilter(needleRow, "embeddings")).toBe(true);
    expect(matchesRoleFilter(needleRow, "chat")).toBe(false);
    expect(matchesRoleFilter(needleRow, "vision")).toBe(false);
    expect(matchesRoleFilter(freeRecord("groq", "a"), "chat")).toBe(true);
    expect(matchesRoleFilter(visionRecord, "vision")).toBe(true);
  });

  it("filters the settings library by capability without touching price filters", async () => {
    const needleRow = freeRecord("offline", NEEDLE_MODEL_ID);
    render(<ModelCatalogSheet models={[freeRecord("groq", "a"), needleRow]} onSelect={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^select$/i })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Capability: Tools" }));
    // Filtered-out rows leave with an exit fade before unmounting.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^select$/i })).toHaveLength(1));
    expect(screen.getByText(NEEDLE_MODEL_ID)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capability: Chat" }));
    await waitFor(() => expect(screen.queryByText(NEEDLE_MODEL_ID)).toBeNull());
  });
});

describe("ModelCatalogSheet assistant picker (U3)", () => {
  function renderAssistant(models: ModelRecord[], props: Record<string, unknown> = {}) {
    const onSelect = vi.fn();
    const onSelectAutomatic = vi.fn();
    render(
      <MemoryRouter>
        <ModelCatalogSheet
          variant="assistant"
          models={models}
          selectedId={null}
          onSelect={onSelect}
          onSelectAutomatic={onSelectAutomatic}
          {...props}
        />
      </MemoryRouter>,
    );
    return { onSelect, onSelectAutomatic };
  }

  it("lists Automatic first, then Chat and Vision sections with locality badges", () => {
    renderAssistant([freeRecord("groq", "a"), visionRecord]);
    expect(screen.getByTestId("model-pick-automatic")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vision" })).toBeTruthy();
    expect(screen.getByText("Cloud")).toBeTruthy();
    expect(screen.getByTestId("model-manage-link").getAttribute("href")).toBe("/settings/ai/models");
  });

  it("never lists tool engines as conversational rows", () => {
    renderAssistant([freeRecord("offline", NEEDLE_MODEL_ID)]);
    expect(screen.queryByText(NEEDLE_MODEL_ID)).toBeNull();
    expect(screen.getByText(/tool engines run automatically/i)).toBeTruthy();
  });

  it("cross-lists a Chat + Vision row in both sections", () => {
    // An image-capable cloud row qualifies for both sections.
    renderAssistant([visionRecord]);
    expect(screen.getAllByText("groq-vision")).toHaveLength(2);
  });

  it("selects Automatic and conversation rows through their callbacks", () => {
    const { onSelect, onSelectAutomatic } = renderAssistant([freeRecord("groq", "a")]);
    fireEvent.click(screen.getByTestId("model-pick-automatic"));
    expect(onSelectAutomatic).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: /^select$/i })[0]!);
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
