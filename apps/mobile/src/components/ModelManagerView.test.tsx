// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHIPPED_CATALOGUE_ENTRIES } from "../services/models/shippedCatalogue";
import { ModelManagerView, type ManagerModel } from "./ModelManagerView";

const candidateRows: ManagerModel[] = SHIPPED_CATALOGUE_ENTRIES.map((entry) => ({
  entryId: entry.id,
  label: entry.displayName,
  role: entry.category === "vision" || entry.category === "multimodal" ? "Vision" : "Text",
  bytes: entry.installedBytes ?? 0,
  category: entry.id === "smolvlm2-500m-litert-int4" || entry.id === "qwen3-0.6b-litert-dynamic-int4" ? "RECOMMENDED" : "EXPERIMENTAL",
  state: "NOT_INSTALLED",
  canDownload: Boolean(entry.pinnedRawSource),
  source: entry.upstreamRepo,
  revision: entry.revision,
  license: entry.license,
  format: entry.format,
  deviceFit: "Not tested on this device",
}));

afterEach(cleanup);

describe("compact Model Manager visual contract", () => {
  it("shows exactly six compact models in order, native RAM and one global Import/Export pair", () => {
    render(<ModelManagerView models={candidateRows} availableRamMb={4300} onAction={() => {}} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByRole("heading", { name: "On-device AI" })).toBeTruthy();
    expect(screen.getByText(/Available memory: 4\.2 GB/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Import model" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Export models" })).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Recommended" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Experimental" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByRole("region", { name: "Imported" })).toBeNull();
    expect(screen.queryByText(/Gemma/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Settings/i })).toBeNull();
  });

  it("keeps technical metadata in Details, not inside a compact model row", () => {
    const onAction = vi.fn();
    render(<ModelManagerView models={candidateRows} availableRamMb={4300} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    const lfm = within(screen.getByRole("region", { name: "Experimental" })).getAllByRole("listitem")[3]!;
    expect(lfm.textContent).toMatch(/LFM2\.5 VL 450M/i);
    expect(lfm.textContent).not.toContain("be196f4");
    expect(lfm.textContent).not.toContain("litert-community");
    fireEvent.click(within(lfm).getByRole("button", { name: /Details for/i }));
    const sheet = screen.getByRole("dialog", { name: /LFM2\.5 VL 450M/i });
    expect(within(sheet).getByText(/be196f4/)).toBeTruthy();
    expect(within(sheet).getByText("LFM Open License v1.0")).toBeTruthy();
    expect(within(sheet).getByText(/Observed compatibility/i)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("displays pause/cancel during download and Verify then Use only after real readiness", () => {
    const onAction = vi.fn();
    const model = { ...candidateRows[2]!, state: "DOWNLOADING" as const, downloadedBytes: 201 * 1024 * 1024 };
    const { rerender } = render(<ModelManagerView models={[model]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toMatch(/^4[0-9]$/);
    fireEvent.click(screen.getByRole("button", { name: /Pause Qwen3/i }));
    expect(onAction).toHaveBeenCalledWith(model.entryId, "pause");
    rerender(<ModelManagerView models={[{ ...model, state: "INSTALLED_UNVERIFIED" }]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByRole("button", { name: /Verify Qwen3/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use Qwen3/i })).toBeNull();
    rerender(<ModelManagerView models={[{ ...model, state: "READY" }]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByRole("button", { name: /Use Qwen3/i })).toBeTruthy();
  });

  it("never offers Use to probe-only entries, even when natively verified", () => {
    const onAction = vi.fn();
    const probeReady = { ...candidateRows[2]!, state: "READY" as const, canUse: false as const };
    const { rerender } = render(<ModelManagerView models={[probeReady]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.queryByRole("button", { name: /Use Qwen3/i })).toBeNull();
    // Experimental probe-only rows offer a device retest instead of Use.
    expect(screen.getByRole("button", { name: /Verify Qwen3/i })).toBeTruthy();
    rerender(<ModelManagerView models={[{ ...probeReady, category: "IMPORTED" as const }]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.queryByRole("button", { name: /Use Qwen3/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Verify Qwen3/i })).toBeNull();
  });

  it("surfaces failed and error states distinctly with a retry path", () => {
    const onAction = vi.fn();
    const failed = { ...candidateRows[2]!, state: "FAILED" as const, error: "Download failed" };
    const { rerender } = render(<ModelManagerView models={[failed]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again Qwen3/i }));
    expect(onAction).toHaveBeenCalledWith(failed.entryId, "tryAgain");
    rerender(<ModelManagerView models={[{ ...failed, state: "ERROR" as const }]} onAction={onAction} onImport={() => {}} onExport={() => {}} />);
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use Qwen3/i })).toBeNull();
  });
  it("never claims device verification from a capacity estimate (AI-06)", () => {
    const estimated = {
      ...candidateRows[2]!,
      state: "NOT_INSTALLED" as const,
      deviceFit: "May fit this device (estimate — not verified on this device)",
    };
    render(<ModelManagerView models={[estimated]} availableRamMb={4300} onAction={() => {}} onImport={() => {}} onExport={() => {}} />);
    expect(screen.queryByText(/Verified on this device/)).toBeNull();
    expect(screen.getByText(/estimate — not verified/i)).toBeTruthy();
  });

  it("renders user-confirmed imported entries only in their own section", () => {
    const imported = { ...candidateRows[2]!, entryId: "imported-example", label: "My Vision Model", category: "IMPORTED" as const, state: "INSTALLED_UNVERIFIED" as const };
    render(<ModelManagerView models={[...candidateRows, imported]} onAction={() => {}} onImport={() => {}} onExport={() => {}} />);
    expect(within(screen.getByRole("region", { name: "Imported" })).getByText("My Vision Model")).toBeTruthy();
  });
});
