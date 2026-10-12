// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ModelCatalogSheet, matchesCatalogFilter, matchesRoleFilter } from "./ModelCatalogSheet";
import type { ModelRecord } from "../services/ai/providerContract";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";
import { SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";

afterEach(() => {
  cleanup();
});

function freeRecord(provider: ModelRecord["provider"], id: string): ModelRecord {
  return {
    provider,
    id,
    displayName: `Test model ${id}`,
    qualifiedRoles: ["chat"],
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
  displayName: "Test vision model",
  qualifiedRoles: ["chat", "vision"],
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

  it("surfaces a free row above a paid row and marks it Recommended, keeping paid selectable", () => {
    const paid: ModelRecord = {
      ...freeRecord("groq", "paid-row"),
      displayName: "Paid chat",
      priceClass: "paid",
    };
    // Free row is listed second: ordering (not input order) must lift it up.
    renderAssistant([paid, freeRecord("groq", "free-row")]);
    expect(screen.getByTestId("model-recommended")).toBeTruthy();
    const chat = screen.getByRole("heading", { name: "Chat" }).parentElement!;
    const names = [...chat.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Test model free-row");
    expect(names[1]).toContain("Paid chat");
    // Paid rows stay user-selectable.
    expect(screen.getAllByRole("button", { name: /^select$/i })).toHaveLength(2);
  });

  it("never lists tool engines as conversational rows", () => {
    renderAssistant([freeRecord("offline", NEEDLE_MODEL_ID)]);
    expect(screen.queryByText(NEEDLE_MODEL_ID)).toBeNull();
    expect(screen.getByText(/tool engines run automatically/i)).toBeTruthy();
  });

  it("does not promote unqualified cloud speech, tools, embeddings or image-shaped rows", () => {
    renderAssistant([
      { ...freeRecord("groq", "speech"), qualifiedRoles: ["stt"] },
      { ...freeRecord("openai", "voice-output"), qualifiedRoles: ["tts"] },
      { ...freeRecord("openrouter", "structured-tool"), qualifiedRoles: ["tools"] },
      { ...freeRecord("openai", "embedding"), qualifiedRoles: ["embeddings"] },
      { ...freeRecord("openrouter", "image-tool"), input: ["text", "image"], qualifiedRoles: undefined },
    ]);
    expect(screen.queryAllByRole("button", { name: /^select$/i })).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Chat" })).toBeNull();
  });

  it("shows SmolVLM2 only under Vision despite a stale cached Chat claim", () => {
    renderAssistant([freeRecord("offline", SMOL_VISION_MODEL_ID)]);
    // FBX-020: the row title is the consumer vision name, never the raw
    // engine id — placement (Vision-only) and identity (model id in
    // technical details) assertions below are unchanged.
    expect(screen.getByText("Photo analysis")).toBeTruthy();
    expect(screen.queryByText("SmolVLM2")).toBeNull();
    expect(screen.getByRole("heading", { name: "Vision" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Chat" })).toBeNull();
    expect(screen.getByText(SMOL_VISION_MODEL_ID).closest("details")).toBeTruthy();
  });

  it("cross-lists a Chat + Vision row in both sections", () => {
    // Both conversational roles are explicitly qualified, not inferred.
    renderAssistant([visionRecord]);
    expect(screen.getAllByText("Test vision model")).toHaveLength(2);
  });

  it("selects Automatic and conversation rows through their callbacks", () => {
    const { onSelect, onSelectAutomatic } = renderAssistant([freeRecord("groq", "a")]);
    fireEvent.click(screen.getByTestId("model-pick-automatic"));
    expect(onSelectAutomatic).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: /^select$/i })[0]!);
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});

describe("consumer catalogue names and speech filters", () => {
  it("uses proper local names and hides raw IDs inside Technical details", () => {
    render(<ModelCatalogSheet models={[freeRecord("offline", NEEDLE_MODEL_ID), freeRecord("offline", SMOL_VISION_MODEL_ID)]} />);
    expect(screen.getByText("Needle3")).toBeTruthy();
    expect(screen.getByText("SmolVLM2")).toBeTruthy();
    expect(screen.getByText(NEEDLE_MODEL_ID).closest("details")).toBeTruthy();
    expect(screen.getAllByText("Technical details")).toHaveLength(2);
  });

  it("keeps an upstream human title and uses an honest generic fallback for unknown names", () => {
    render(<ModelCatalogSheet models={[
      { ...freeRecord("openrouter", "vendor/model-42"), displayName: "Friendly upstream model" },
      { ...freeRecord("generic", "opaque-id-999"), displayName: undefined },
    ]} />);
    expect(screen.getByText("Friendly upstream model")).toBeTruthy();
    expect(screen.getByText("Cloud model")).toBeTruthy();
    expect(screen.getByText("opaque-id-999").closest("details")).toBeTruthy();
  });

  it("filters pure speech engines separately without showing them under Chat", async () => {
    render(<ModelCatalogSheet models={[
      { ...freeRecord("groq", "whisper"), displayName: "Whisper", qualifiedRoles: ["stt"] },
      { ...freeRecord("openai", "tts-1"), displayName: "TTS 1", qualifiedRoles: ["tts"] },
    ]} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Capability: Speech to text" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^select$/i })).toHaveLength(1));
    expect(screen.getByText("Whisper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capability: Text to speech" }));
    await waitFor(() => expect(screen.queryByText("Whisper")).toBeNull());
    expect(screen.getByText("TTS 1")).toBeTruthy();
  });
});
