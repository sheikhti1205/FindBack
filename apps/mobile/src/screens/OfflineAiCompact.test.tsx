// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineAiCompact } from "./OfflineAiCompact";
import * as photo from "../services/photo";

function fakeVlm() {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ availableRamMb: 4300 }),
    getModelStates: vi.fn().mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]),
    downloadModel: vi.fn().mockResolvedValue(undefined),
    pauseDownload: vi.fn().mockResolvedValue(undefined),
    resumeDownload: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    runGpuSelfTest: vi.fn().mockResolvedValue({ state: "GPU_AVAILABLE" }),
    runTextSelfTest: vi.fn().mockResolvedValue({ ready: true, state: "TEXT_READY" }),
    getTextRuntimeStatus: vi.fn().mockResolvedValue({ textInstalled: false, textReady: false }),
    onDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
    onModelStateChange: vi.fn().mockResolvedValue(() => undefined),
  };
}

function fakeCandidates(state = "NOT_INSTALLED") {
  return {
    getStates: vi.fn().mockResolvedValue([
      { entryId: "qwen3-0.6b-litert-mixed-int4", state, installed: false, sizeBytes: 497516544, downloadedBytes: 0 },
      { entryId: "qwen3-0.6b-litert-int8", state: "NOT_INSTALLED", installed: false, sizeBytes: 614236160, downloadedBytes: 0 },
      { entryId: "lfm2.5-1.2b-instruct-litert-int4-gpu", state: "NOT_INSTALLED", installed: false, sizeBytes: 736220768, downloadedBytes: 0 },
      { entryId: "lfm2.5-vl-450m", state: "NOT_INSTALLED", installed: false, sizeBytes: 406817104, downloadedBytes: 0 },
    ]),
    download: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue({ entryId: "qwen3-0.6b-litert-mixed-int4", ready: true, observedOnThisDevice: true, loadMs: 10, inferenceMs: 20 }),
    delete: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn().mockResolvedValue(() => undefined),
    onProgress: vi.fn().mockResolvedValue(() => undefined),
  };
}

const manifest = {
  packageVersion: "1" as const,
  entryId: "staged-unknown",
  upstream: { repo: "fixture", rev: "v", file: "model.litertlm" },
  createdAt: "2026-09-23T00:00:00Z",
  files: [{ path: "weights/model.litertlm", bytes: 31, sha256: "ab", method: "STORE" as const }],
};

function fakeTransfers(overrides: Record<string, unknown> = {}) {
  return {
    pickImport: vi.fn().mockResolvedValue({ uri: "content://pkg", name: "custom.fbmodel" }),
    inspect: vi.fn().mockResolvedValue({ inspectionId: "s1", entryId: "staged-unknown", packageSha256: "cd", unknown: true, manifest }),
    commit: vi.fn().mockResolvedValue({ entryId: "staged-unknown" }),
    commitDetailed: vi.fn().mockResolvedValue({ entryId: "imported-1" }),
    probe: vi.fn().mockResolvedValue({ ready: true, lowMemory: false, loadMs: 12, inferenceMs: 34 }),
    getImported: vi.fn().mockResolvedValue([]),
    deleteImported: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    importKnown: vi.fn().mockResolvedValue(undefined),
    exportAll: vi.fn().mockResolvedValue([{ entryId: "lfm2.5-vl-450m", fileName: "lfm2.5-vl-450m.fbmodel", ok: true }]),
    ...overrides,
  };
}

afterEach(cleanup);

describe("OfflineAiCompact six-model route", () => {
  it("renders the compact six-entry contract with measured RAM and one Import/Export pair", async () => {
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    expect(await screen.findByRole("heading", { name: "On-device AI" })).toBeTruthy();
    expect(await screen.findByText(/Available memory: 4\.2 GB/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Import model" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Export models" })).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Recommended" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Experimental" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByRole("region", { name: "Imported" })).toBeNull();
    expect(screen.queryByText(/Gemma/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Settings/i })).toBeNull();
  });

  it("blocks known-package Download while UNPUBLISHED and says so honestly", async () => {
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const recommended = screen.getByRole("region", { name: "Recommended" });
    await waitFor(() => expect(within(recommended).getAllByRole("listitem")).toHaveLength(2));
    expect(within(recommended).queryByRole("button", { name: /Download SmolVLM2/i })).toBeNull();
    expect(within(recommended).queryByRole("button", { name: /Download Qwen3/i })).toBeNull();
    expect(within(recommended).getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  });

  it("gates a candidate download behind explicit confirmation, then calls the host", async () => {
    const candidates = fakeCandidates();
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    const download = within(experimental).getAllByRole("button", { name: /Download/i })[0]!;
    fireEvent.click(download);
    expect(await screen.findByRole("dialog", { name: /Confirm download/i })).toBeTruthy();
    expect(candidates.download).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirm download" });
    // Experimental entries require acknowledgement before confirm enables.
    if ((confirm as HTMLButtonElement).disabled) {
      fireEvent.click(screen.getByRole("checkbox"));
    }
    fireEvent.click(screen.getByRole("button", { name: "Confirm download" }));
    await waitFor(() => expect(candidates.download).toHaveBeenCalled());
  });

  it("verifies a candidate to Ready but reports Use as verified-only without a wired runtime", async () => {
    const candidates = fakeCandidates("INSTALLED_UNVERIFIED");
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Verify/i })[0]!);
    const use = await within(experimental).findAllByRole("button", { name: /Use/i });
    expect(use.length).toBeGreaterThan(0);
    fireEvent.click(use[0]!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/verified only|no executable runtime/i);
  });

  it("does not stack native progress listeners each time the library refreshes", async () => {
    const vlm = fakeVlm();
    const candidates = fakeCandidates("INSTALLED_UNVERIFIED");
    render(<OfflineAiCompact vlm={vlm} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    await waitFor(() => expect(candidates.onProgress).toHaveBeenCalledOnce());
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Verify/i })[0]!);
    await within(experimental).findAllByRole("button", { name: /Use/i });
    await waitFor(() => expect(candidates.getStates).toHaveBeenCalledTimes(2));
    expect(candidates.onProgress).toHaveBeenCalledOnce();
    expect(vlm.onDownloadProgress).toHaveBeenCalledOnce();
  });

  it("completes the unknown import flow with a confirmed name and role, then commits", async () => {
    const transfers = fakeTransfers();
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
    await screen.findByRole("heading", { name: "On-device AI" });
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));
    expect(await screen.findByRole("dialog", { name: "Import model" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "My Vision Model" } });
    fireEvent.click(screen.getByRole("button", { name: "Test compatibility" }));
    await waitFor(() => expect(transfers.probe).toHaveBeenCalledWith(expect.objectContaining({ inspectionId: "s1", role: "Text" })));
    expect(await screen.findByText(/Compatibility test passed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to model library" }));
    await waitFor(() => expect(transfers.commitDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ inspectionId: "s1", name: "My Vision Model", role: "Text" }),
    ));
  });

  it("offers Keep anyway on typed memory failure and never promotes it to Ready", async () => {
    const transfers = fakeTransfers({
      probe: vi.fn().mockResolvedValue({ ready: false, lowMemory: true }),
      commitDetailed: vi.fn().mockResolvedValue({ entryId: "imported-lowmem" }),
    });
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
    await screen.findByRole("heading", { name: "On-device AI" });
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));
    expect(await screen.findByRole("dialog", { name: "Import model" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Big Model" } });
    fireEvent.click(screen.getByRole("button", { name: "Test compatibility" }));
    expect(await screen.findByText(/wasn't enough available memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep anyway" }));
    await waitFor(() => expect(transfers.commitDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ keepUnverified: true, name: "Big Model" }),
    ));
    expect(screen.queryByText(/Verified on this device/)).toBeNull();
  });

  it("uses the real gallery picker for a vision probe when no picker seam is injected", async () => {
    const gallery = vi.spyOn(photo, "chooseFromGallery").mockResolvedValue({ nativeUri: "content://test-image", webPath: "", format: "jpg" });
    const transfers = fakeTransfers();
    try {
      render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
      fireEvent.click(screen.getByRole("button", { name: "Import model" }));
      await screen.findByRole("dialog", { name: "Import model" });
      fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "My Vision Model" } });
      fireEvent.click(screen.getByRole("radio", { name: "Images" }));
      fireEvent.click(screen.getByRole("button", { name: "Test compatibility" }));
      await waitFor(() => expect(transfers.probe).toHaveBeenCalledWith({
        inspectionId: "s1", role: "Vision", imageUri: "content://test-image",
      }));
      expect(gallery).toHaveBeenCalledOnce();
    } finally {
      gallery.mockRestore();
    }
  });

  it("requires a new compatibility test when the confirmed import role changes", async () => {
    const transfers = fakeTransfers();
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));
    await screen.findByRole("dialog", { name: "Import model" });
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "My Model" } });
    fireEvent.click(screen.getByRole("button", { name: "Test compatibility" }));
    await screen.findByRole("button", { name: "Add to model library" });
    fireEvent.click(screen.getByRole("radio", { name: "Images" }));
    expect(screen.queryByRole("button", { name: "Add to model library" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test compatibility" })).toBeTruthy();
    expect(transfers.commitDetailed).not.toHaveBeenCalled();
  });

  it("renders user-confirmed imported models only when present", async () => {
    const transfers = fakeTransfers({
      getImported: vi.fn().mockResolvedValue([
        { entryId: "imported-1", label: "My Vision Model", description: null, role: "Vision", state: "INSTALLED_UNVERIFIED", bytes: 416000000 },
      ]),
    });
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
    expect(await screen.findByRole("region", { name: "Imported" })).toBeTruthy();
    expect(screen.getByText("My Vision Model")).toBeTruthy();
  });

  it("exports selected installed models with a byte-derived total and per-file results", async () => {
    const transfers = fakeTransfers();
    const candidates = fakeCandidates("INSTALLED_UNVERIFIED");
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={transfers} ramOverrideMb={4300} />);
    await screen.findByRole("heading", { name: "On-device AI" });
    fireEvent.click(screen.getByRole("button", { name: "Export models" }));
    expect(await screen.findByRole("dialog", { name: "Export models" })).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    expect(screen.getByText(/1 model ·/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Choose destination & export/i }));
    await waitFor(() => expect(transfers.exportAll).toHaveBeenCalled());
    expect(await screen.findByText(/✓ lfm2\.5-vl-450m\.fbmodel/)).toBeTruthy();
  });
});
