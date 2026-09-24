// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeManagerAction, OfflineAiCompact } from "./OfflineAiCompact";
import type { ManagerModel } from "../components/ModelManagerView";
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
    generateText: vi.fn().mockResolvedValue({ text: "hi", modelId: "qwen3-0.6b" }),
    cancelInference: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    downloadTextModel: vi.fn().mockResolvedValue(undefined),
    pauseTextDownload: vi.fn().mockResolvedValue(undefined),
    resumeTextDownload: vi.fn().mockResolvedValue(undefined),
    cancelTextDownload: vi.fn().mockResolvedValue(undefined),
    deleteTextModel: vi.fn().mockResolvedValue(undefined),
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

  it("never renders Use for probe-only models, even when the candidate host reports verified readiness", async () => {
    const candidates = fakeCandidates("READY");
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    await waitFor(() => expect(candidates.getStates).toHaveBeenCalled());
    // Authoritative native READY still offers retest, never Use.
    const verify = await within(experimental).findAllByRole("button", { name: /Verify/i });
    expect(verify.length).toBeGreaterThan(0);
    expect(within(experimental).queryByRole("button", { name: /Use/i })).toBeNull();
  });

  it("Use activates the runnable image seam when SmolVLM2 reports ready", async () => {
    const vlm = fakeVlm();
    vlm.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "READY_GPU" }]);
    render(<OfflineAiCompact vlm={vlm} candidates={fakeCandidates()} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const recommended = await screen.findByRole("region", { name: "Recommended" });
    const use = await within(recommended).findByRole("button", { name: /Use SmolVLM2/i });
    fireEvent.click(use);
    await waitFor(() => expect(vlm.cancelInference).toHaveBeenCalled());
    expect(vlm.release).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Use activates the runnable text seam when Qwen reports text-ready", async () => {
    const vlm = fakeVlm();
    vlm.getTextRuntimeStatus.mockResolvedValue({ textInstalled: true, textReady: true });
    render(<OfflineAiCompact vlm={vlm} candidates={fakeCandidates()} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const recommended = await screen.findByRole("region", { name: "Recommended" });
    const use = await within(recommended).findByRole("button", { name: /Use Qwen3/i });
    fireEvent.click(use);
    await waitFor(() => expect(vlm.cancelInference).toHaveBeenCalled());
    expect(vlm.release).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not stack native progress listeners each time the library refreshes", async () => {
    const vlm = fakeVlm();
    const candidates = fakeCandidates("INSTALLED_UNVERIFIED");
    render(<OfflineAiCompact vlm={vlm} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    await waitFor(() => expect(candidates.onProgress).toHaveBeenCalledOnce());
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Verify/i })[0]!);
    // Authoritative refresh keeps the row at Verify (no optimistic Ready),
    // while native state is re-read exactly once.
    await waitFor(() => expect(candidates.getStates).toHaveBeenCalledTimes(2));
    expect(within(experimental).getAllByRole("button", { name: /Verify/i })).toHaveLength(1);
    expect(within(experimental).queryByRole("button", { name: /Use/i })).toBeNull();
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

  it("shows the exact matched catalogue label and entry identity before known Install", async () => {
    const transfers = fakeTransfers({
      inspect: vi.fn().mockResolvedValue({
        inspectionId: "s2",
        entryId: "smolvlm2-500m-litert-int4",
        packageSha256: "ee",
        unknown: false,
        manifest,
      }),
    });
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={transfers} ramOverrideMb={4300} />);
    await screen.findByRole("heading", { name: "On-device AI" });
    fireEvent.click(screen.getByRole("button", { name: "Import model" }));
    const dialog = await screen.findByRole("dialog", { name: "Import model" });
    expect(within(dialog).getByText("Model recognized")).toBeTruthy();
    expect(within(dialog).getByText(/SmolVLM2 500M \(LiteRT, int4\)/)).toBeTruthy();
    expect(within(dialog).getByText(/smolvlm2-500m-litert-int4/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(transfers.commitDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ inspectionId: "s2" }),
    ));
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

  it("renders NOT_INSTALLED rows with Unknown memory when native reads fail", async () => {
    const vlm = fakeVlm();
    vlm.getCapabilities.mockResolvedValue({});
    vlm.getModelStates.mockRejectedValue(new Error("no-bridge-states"));
    const candidates = fakeCandidates();
    candidates.getStates.mockRejectedValue(new Error("no-candidate-states"));
    render(<OfflineAiCompact vlm={vlm} candidates={candidates} transfers={fakeTransfers()} />);
    expect(await screen.findByRole("heading", { name: "On-device AI" })).toBeTruthy();
    expect(await screen.findByText("Available memory: Unknown")).toBeTruthy();
    const recommended = screen.getByRole("region", { name: "Recommended" });
    const experimental = screen.getByRole("region", { name: "Experimental" });
    await waitFor(() => {
      expect(within(recommended).getAllByRole("listitem")).toHaveLength(2);
      expect(within(experimental).getAllByRole("listitem")).toHaveLength(4);
    });
    // Catalogue rows render from shipped truth even with no live state;
    // experimental rows stay installable, recommended stay honestly unavailable.
    expect(within(experimental).getAllByRole("button", { name: /Download/i })).toHaveLength(4);
    expect(within(recommended).getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  });

  it("shows the real pinned revision and the untested-device warning in entry details", async () => {
    // Unknown RAM keeps the honest untested-device fallback instead of a fit claim.
    const vlm = fakeVlm();
    vlm.getCapabilities.mockResolvedValue({});
    render(<OfflineAiCompact vlm={vlm} candidates={fakeCandidates()} transfers={fakeTransfers()} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Details for/i })[0]!);
    const dialog = await screen.findByRole("dialog", { name: /details/i });
    expect(within(dialog).getByText("Pinned revision")).toBeTruthy();
    expect(within(dialog).getByText("a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76")).toBeTruthy();
    expect(within(dialog).getByText(/Not tested on this device/)).toBeTruthy();
  });

  it("discloses the exact download size in the confirm dialog", async () => {
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={fakeCandidates()} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Download/i })[0]!);
    const dialog = await screen.findByRole("dialog", { name: /Confirm download/i });
    // 497516544 B formats to 474 MB — never a placeholder, never hidden.
    expect(within(dialog).getByText("Download size: 474 MB.")).toBeTruthy();
  });

  it("keeps Pause/Cancel — never Download — on an in-flight transfer row", async () => {
    const candidates = fakeCandidates();
    candidates.getStates.mockResolvedValue([
      { entryId: "qwen3-0.6b-litert-mixed-int4", state: "DOWNLOADING", installed: false, sizeBytes: 497516544, downloadedBytes: 100663296 },
      { entryId: "qwen3-0.6b-litert-int8", state: "NOT_INSTALLED", installed: false, sizeBytes: 614236160, downloadedBytes: 0 },
      { entryId: "lfm2.5-1.2b-instruct-litert-int4-gpu", state: "NOT_INSTALLED", installed: false, sizeBytes: 736220768, downloadedBytes: 0 },
      { entryId: "lfm2.5-vl-450m", state: "NOT_INSTALLED", installed: false, sizeBytes: 406817104, downloadedBytes: 0 },
    ]);
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    await waitFor(() => expect(within(experimental).getByRole("button", { name: /Pause/i })).toBeTruthy());
    expect(within(experimental).getByRole("button", { name: /Cancel/i })).toBeTruthy();
    expect(within(experimental).queryByRole("button", { name: /Download Qwen3.*mixed|Download.*Mixed/i })).toBeNull();
    expect(within(experimental).getAllByRole("button", { name: /Download/i })).toHaveLength(3);
    expect(within(experimental).getByRole("progressbar")).toBeTruthy();
  });

  it("surfaces a failed download as an honest alert with nothing installed", async () => {
    const candidates = fakeCandidates();
    candidates.download.mockRejectedValue(new Error("candidate-offline-no-bytes-moved"));
    render(<OfflineAiCompact vlm={fakeVlm()} candidates={candidates} transfers={fakeTransfers()} ramOverrideMb={4300} />);
    const experimental = await screen.findByRole("region", { name: "Experimental" });
    fireEvent.click(within(experimental).getAllByRole("button", { name: /Download/i })[0]!);
    await screen.findByRole("dialog", { name: /Confirm download/i });
    const confirm = screen.getByRole("button", { name: "Confirm download" });
    if ((confirm as HTMLButtonElement).disabled) {
      fireEvent.click(screen.getByRole("checkbox"));
    }
    fireEvent.click(screen.getByRole("button", { name: "Confirm download" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch("candidate-offline-no-bytes-moved");
    expect(candidates.download).toHaveBeenCalled();
  });
});

function modelFor(entryId: string, category: ManagerModel["category"]): ManagerModel {
  return { entryId, label: entryId, role: "Text", bytes: 100, category, state: "NOT_INSTALLED", canDownload: false };
}

function actionCtx(seams: Record<string, unknown>, model: ManagerModel) {
  return {
    model,
    vlm: null,
    candidates: null,
    transfers: null,
    vlmStates: [] as Array<{ id: string; state: string }>,
    textStatus: null,
    activeId: null,
    ramMb: 4300,
    pickTestImage: vi.fn().mockResolvedValue(null),
    onBecameActive: vi.fn(),
    onImportedDeleted: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...seams,
  };
}

describe("OfflineAiCompact single entry-id dispatcher", () => {
  it("routes Smol pause/delete to the image seam even with no bridge state cached", async () => {
    const vlm = fakeVlm();
    const candidates = fakeCandidates();
    const ctx = actionCtx({ vlm, candidates }, modelFor("smolvlm2-500m-litert-int4", "RECOMMENDED"));
    await executeManagerAction("smolvlm2-500m-litert-int4", "pause", ctx as never);
    expect(vlm.pauseDownload).toHaveBeenCalledWith("smolvlm2-500m");
    expect(candidates.pause).not.toHaveBeenCalled();
    await executeManagerAction("smolvlm2-500m-litert-int4", "delete", ctx as never);
    expect(vlm.deleteModel).toHaveBeenCalledWith("smolvlm2-500m");
    expect(candidates.delete).not.toHaveBeenCalled();
  });

  it("routes Qwen pause/resume/cancel/delete to the text seam, never the candidate host", async () => {
    const vlm = fakeVlm();
    const candidates = fakeCandidates();
    const model = modelFor("qwen3-0.6b-litert-dynamic-int4", "RECOMMENDED");
    const pauseCtx = actionCtx({ vlm, candidates }, model);
    await executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "pause", pauseCtx as never);
    expect(vlm.pauseTextDownload).toHaveBeenCalledWith({ modelId: "qwen3-0.6b" });
    await executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "resume", actionCtx({ vlm, candidates }, model) as never);
    expect(vlm.resumeTextDownload).toHaveBeenCalledWith({ modelId: "qwen3-0.6b" });
    await executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "cancel", actionCtx({ vlm, candidates }, model) as never);
    expect(vlm.cancelTextDownload).toHaveBeenCalledWith({ modelId: "qwen3-0.6b" });
    await executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "delete", actionCtx({ vlm, candidates }, model) as never);
    expect(vlm.deleteTextModel).toHaveBeenCalledWith({ modelId: "qwen3-0.6b" });
    expect(candidates.pause).not.toHaveBeenCalled();
    expect(candidates.download).not.toHaveBeenCalled();
    expect(candidates.cancel).not.toHaveBeenCalled();
    expect(candidates.delete).not.toHaveBeenCalled();
  });

  it("fails closed with an honest error when the native text transfer methods are absent", async () => {
    const full = fakeVlm();
    const { downloadTextModel, pauseTextDownload, resumeTextDownload, cancelTextDownload, deleteTextModel, ...vlm } = full;
    expect([downloadTextModel, pauseTextDownload, resumeTextDownload, cancelTextDownload, deleteTextModel].length).toBe(5);
    const candidates = fakeCandidates();
    const ctx = actionCtx({ vlm, candidates }, modelFor("qwen3-0.6b-litert-dynamic-int4", "RECOMMENDED"));
    await expect(executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "pause", ctx as never))
      .rejects.toThrow(/unavailable for the text runtime/i);
    expect(candidates.pause).not.toHaveBeenCalled();
  });
  it("keeps Qwen downloads honestly blocked while the release record is UNPUBLISHED", async () => {
    const vlm = fakeVlm();
    const candidates = fakeCandidates();
    const ctx = actionCtx({ vlm, candidates }, modelFor("qwen3-0.6b-litert-dynamic-int4", "RECOMMENDED"));
    await expect(executeManagerAction("qwen3-0.6b-litert-dynamic-int4", "download", ctx as never)).rejects.toThrow(/not published/i);
    expect(candidates.download).not.toHaveBeenCalled();
    expect(vlm.downloadModel).not.toHaveBeenCalled();
  });

  it("routes experimental delete to the candidate host and rejects probe-only Use honestly", async () => {
    const candidates = fakeCandidates();
    const model = modelFor("lfm2.5-vl-450m", "EXPERIMENTAL");
    const ctx = actionCtx({ vlm: fakeVlm(), candidates }, model);
    await executeManagerAction("lfm2.5-vl-450m", "delete", ctx as never);
    expect(candidates.delete).toHaveBeenCalledWith("lfm2.5-vl-450m");
    await expect(executeManagerAction("lfm2.5-vl-450m", "use", actionCtx({ vlm: fakeVlm(), candidates }, model) as never))
      .rejects.toThrow(/verified only|no executable runtime/i);
  });

  it("routes imported delete to the transfer host", async () => {
    const transfers = fakeTransfers();
    const model = modelFor("imported-1", "IMPORTED");
    const ctx = actionCtx({ transfers }, model);
    await executeManagerAction("imported-1", "delete", ctx as never);
    expect(transfers.deleteImported).toHaveBeenCalledWith("imported-1");
    expect(ctx.onImportedDeleted).toHaveBeenCalledWith("imported-1");
  });
});
