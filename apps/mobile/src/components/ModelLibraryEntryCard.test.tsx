// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelLibraryEntryCard } from "./ModelLibraryEntryCard";
import type { ModelCatalogueEntry } from "../services/models/catalogueTypes";

afterEach(() => cleanup());

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "qwen3-0.6b-litert-dynamic-int4",
    displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
    category: "text",
    role: "chat-text",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "a3c5d805",
    license: "apache-2.0",
    downloadBytes: 344671744,
    installedBytes: 344671744,
    sha256: null,
    minFreeRamMb: 1280,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    ramNotes: "Formula: 328+700=1028 -> 1280.",
    verificationStatus: "SUPPORTED_UNVERIFIED",
    description: "First text target.",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
    ...overrides,
  };
}

describe("ModelLibraryEntryCard", () => {
  it("shows the RAM triple plus the estimate source chip", () => {
    render(<ModelLibraryEntryCard entry={entry()} availableFreeRamMb={2000} />);
    expect(screen.getByTestId("model-ram-min").textContent).toContain("Minimum free RAM");
    expect(screen.getByTestId("model-ram-rec").textContent).toContain("Recommended");
    expect(screen.getByTestId("model-ram-now").textContent).toContain("Your device now:");
    expect(screen.getByTestId("model-ram-source-chip").textContent).toContain(
      "Conservative estimate",
    );
    expect(screen.getByTestId("model-verification-badge").textContent).toContain(
      "Supported (unverified)",
    );
  });

  it("records the LFM license verbatim, never as Apache", () => {
    render(
      <ModelLibraryEntryCard
        entry={entry({ license: "lfm-open-1.0" })}
        availableFreeRamMb={null}
      />,
    );
    expect(screen.getByTestId("model-license").textContent).toContain("LFM Open License v1.0");
    expect(screen.getByTestId("model-ram-now").textContent).toContain("unknown");
  });

  it("warns on catalogue-only entries and hides the install affordance", () => {
    render(
      <ModelLibraryEntryCard
        entry={entry({ catalogOnly: true, category: "experimental-large" })}
        availableFreeRamMb={99999}
      />,
    );
    expect(screen.getAllByTestId("model-warning").length).toBeGreaterThan(0);
    expect(screen.getByTestId("model-not-installable-note")).toBeTruthy();
    expect(screen.queryByTestId("model-select-button")).toBeNull();
  });

  it("selects an installable entry via callback only", () => {
    const onSelect = vi.fn();
    render(
      <ModelLibraryEntryCard entry={entry()} availableFreeRamMb={3000} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("model-select-button"));
    expect(onSelect).toHaveBeenCalledWith("qwen3-0.6b-litert-dynamic-int4");
  });
});
