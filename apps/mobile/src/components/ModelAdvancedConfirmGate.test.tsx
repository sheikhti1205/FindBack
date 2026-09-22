// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelAdvancedConfirmGate } from "./ModelAdvancedConfirmGate";
import type { ModelCatalogueEntry } from "../services/models/catalogueTypes";

afterEach(() => cleanup());

const base: ModelCatalogueEntry = {
  id: "gemma-3n-e2b-it-litert-int4",
  displayName: "Gemma 3n E2B IT (LiteRT, int4)",
  category: "experimental-large",
  role: "catalog-reference",
  runtime: "litert-lm",
  format: "litertlm",
  revision: "UNKNOWN_NOT_ESTABLISHED",
  license: "gemma",
  downloadBytes: null,
  installedBytes: null,
  sha256: null,
  minFreeRamMb: 4096,
  recommendedFreeRamMb: 6144,
  ramRequirementSource: "CONSERVATIVE_ESTIMATE",
  ramNotes: "Class-based floor only.",
  verificationStatus: "EXPERIMENTAL",
  catalogOnly: true,
  requiresAdvancedConfirm: true,
  description: "Catalog only.",
  supportedCapabilities: ["catalog-reference"],
  upstreamRepo: "google/gemma-3n-E2B-it-litert-lm-preview",
  provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
};

describe("ModelAdvancedConfirmGate", () => {
  it("keeps confirm disabled until the explicit acknowledgement is checked", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ModelAdvancedConfirmGate
        entry={base}
        availableFreeRamMb={1000}
        acknowledged={false}
        onAcknowledgedChange={() => undefined}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("model-gate-confirm")).toHaveProperty("disabled", true);

    rerender(
      <ModelAdvancedConfirmGate
        entry={base}
        availableFreeRamMb={1000}
        acknowledged
        onAcknowledgedChange={() => undefined}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("model-gate-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requires the second step for large entries", () => {
    render(
      <ModelAdvancedConfirmGate
        entry={base}
        availableFreeRamMb={1000}
        acknowledged
        onAcknowledgedChange={() => undefined}
        secondConfirmed={false}
        onSecondConfirmedChange={() => undefined}
        requireSecondConfirm
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("model-gate-second-confirm")).toBeTruthy();
    expect(screen.getByTestId("model-gate-confirm")).toHaveProperty("disabled", true);
  });

  it("shows the figures, source chip, and the no-bypass note", () => {
    const onCancel = vi.fn();
    render(
      <ModelAdvancedConfirmGate
        entry={base}
        availableFreeRamMb={1000}
        acknowledged={false}
        onAcknowledgedChange={() => undefined}
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByTestId("model-gate-source-chip").textContent).toContain(
      "Conservative estimate",
    );
    expect(screen.getByTestId("model-gate-ram-notes").textContent).toContain("Class-based floor");
    fireEvent.click(screen.getByTestId("model-gate-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
