// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR as descriptor } from "../services/ai/modelDescriptors";
import { buildJournal } from "../services/ai/download/journal";
import { DownloadedModels } from "./DownloadedModels";

afterEach(cleanup);

function device({ failStorage = false, abi = "arm64-v8a" } = {}) {
  const files = new Map<string, string>();
  let staged = 0;
  let journal: string | null = null;
  const offsets: number[] = [];
  const removed: string[] = [];
  let unloaded = false;
  const service = new ApplicationAiService({ android: true, driver: {
    supportedAbis: async () => [abi],
    rootDir: async () => { if (failStorage) throw new Error("disk unavailable"); return "/private/models"; }, freeBytes: async () => 2e9,
    stagedSize: async () => staged, readJournalText: async () => journal,
    download: async (attempt) => {
      offsets.push(attempt.resumeOffset);
      if (offsets.length === 1) {
        staged = 1024;
        journal = JSON.stringify(buildJournal({ url: attempt.url, filePath: attempt.fileName, sha: attempt.expectedSha256, offset: staged, total: attempt.maxBytes, modelId: attempt.modelId, revision: attempt.revision }));
        attempt.onProgress?.(staged, attempt.maxBytes);
        await new Promise<void>((_, reject) => attempt.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      }
      files.set(attempt.stagingPath, attempt.expectedSha256);
      attempt.onProgress?.(attempt.maxBytes - attempt.resumeOffset, attempt.maxBytes);
      return { receivedBytes: attempt.maxBytes - attempt.resumeOffset, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    }, cancelDownload: async () => {},
    hashFile: async (path) => { if (!files.has(path)) throw new Error("missing"); return files.get(path)!; },
    promoteFile: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); staged = 0; },
    removeFile: async (path) => { expect(unloaded).toBe(true); files.delete(path); removed.push(path); staged = 0; },
  }, needle: {
    bridgeName: "needle-cact", unload: async () => { unloaded = true; }, isNeedleAvailable: async () => false,
    loadModel: async () => 2, embeddingDimension: async () => 2, embedNeedleTexts: async () => [],
    initTools: async () => {}, completeJson: async () => "{}",
  }, smol: {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
    collectDeviceFacts: async () => ({ supportedAbis: [abi] }),
  } });
  return { service, offsets, files, removed };
}

describe("Downloaded models", () => {
  it("uses the real lifecycle for explicit download, pause, resume and confirmed removal", async () => {
    const { service, offsets, removed } = device();
    await service.ready;
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    const download = await screen.findByRole("button", { name: "Download · 35.3 MB" });
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
    expect(offsets).toEqual([]);
    fireEvent.click(download);
    const pause = await screen.findByRole("button", { name: "Pause" });
    expect(screen.getByRole("progressbar", { name: "Local search helper download progress" })).toBeTruthy();
    fireEvent.click(pause);
    const resume = await screen.findByRole("button", { name: "Resume" });
    await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resume);
    await screen.findByText("Installed");
    expect(offsets).toEqual([0, 1024]);
    expect(service.manager.statusOf(descriptor.modelId)?.checksumVerified).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove local search helper" }));
    const dialog = screen.getByRole("dialog", { name: "Remove local search helper?" });
    expect(screen.getByRole("heading", { level: 1, hidden: true }).closest("[inert]")).toBeTruthy();
    expect(within(dialog).getByText(/normal search will still work/i)).toBeTruthy();
    expect(within(dialog).getByText(/report text assistance/i)).toBeTruthy();
    expect(removed).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep helper" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Remove local search helper" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove helper" }));
    await screen.findByText("Not downloaded");
    expect(removed.length).toBeGreaterThan(0);
    expect(service.matchingBackend).toBe("use");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByText("Local search helper removed. Normal search is still available."));
  });
  it("groups assets without fabricating storage totals or removable built-in files", async () => {
    const service = new ApplicationAiService({ android: false });
    const { container } = render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    expect(screen.getByText("Total storage use unavailable")).toBeTruthy();
    const builtIn = screen.getByRole("region", { name: "Built-in" });
    expect(within(builtIn).getByText("Semantic text matching")).toBeTruthy();
    expect(within(builtIn).queryByRole("button")).toBeNull();
    expect(screen.getByRole("region", { name: "Smart Search" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Matching" })).toBeTruthy();
    await screen.findByText("Downloads need the Android app.");
    expect(container.textContent).not.toMatch(/Qwen|Smol|checksum|runtime|SHA|Balanced|Best/);
    // No stale pointer to the retired generative catalogue on a clean install.
    expect(container.textContent).not.toMatch(/other on-device models|AI & models/);
    expect(container.textContent).not.toMatch(/older files may also use space/i);
  });
  it("removes an unfinished download as the confirmation promises", async () => {
    const { service, files } = device();
    await service.ready;
    // A partial (staged, not installed) transfer is still removable.
    act(() => {
      service.manager.dispatch(descriptor.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      service.manager.dispatch(descriptor.modelId, { type: "START" });
      service.manager.dispatch(descriptor.modelId, { type: "PROGRESS", downloadedBytes: 1024 });
    });
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    const remove = await screen.findByRole("button", { name: "Remove local search helper" });
    fireEvent.click(remove);
    const dialog = screen.getByRole("dialog", { name: "Remove local search helper?" });
    expect(within(dialog).getByText(/unfinished download/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove helper" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(files.size).toBe(0);
  });
  it("keeps the removal action reachable when the model store cannot be read", async () => {
    const { service } = device();
    await service.ready;
    act(() => {
      service.manager.dispatch(descriptor.modelId, { type: "FAIL", reason: "Model storage could not be verified. Retry from AI & Models." });
    });
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    // The failure names the real cause and does not strand the user: the
    // canonical removal path still works.
    await screen.findByText(/couldn't check the downloaded files on this device/i);
    expect(screen.getByRole("button", { name: "Remove local search helper" })).toBeTruthy();
  });
  it("retries a removal that was refused as busy", async () => {
    const { service } = device();
    await service.ready;
    // An interrupted transfer leaves files on the device, so removal applies.
    act(() => {
      service.manager.dispatch(descriptor.modelId, { type: "FAIL", reason: "transfer failed" });
    });
    const remove = vi.spyOn(service, "remove")
      .mockRejectedValueOnce(new Error("On-device runtime is busy; stop inference before removing a model"))
      .mockResolvedValueOnce(undefined);
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    const trigger = await screen.findByRole("button", { name: "Remove local search helper" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove helper" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "This tool is in use. Try again when it has finished.");
    // The sheet stays open with the honest reason, and a second attempt works.
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove helper" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/local search helper removed/i)).toBeTruthy();
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("shows failures safely and offers a real retry instead of raw diagnostics", async () => {
    const { service } = device();
    await service.ready;
    act(() => { service.manager.dispatch(descriptor.modelId, { type: "FAIL", reason: "checksum mismatch against catalogue pin" }); });
    const { container } = render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    expect(await screen.findByText("Needs repair")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download again" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/checksum|catalogue pin/);
  });
  it("checks an installed file through the secondary file action and drops missing-file readiness", async () => {
    const { service } = device();
    await service.ready;
    service.manager.dispatch(descriptor.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(descriptor.modelId, { type: "START" });
    service.manager.dispatch(descriptor.modelId, { type: "VERIFY_START" });
    service.manager.dispatch(descriptor.modelId, { type: "VERIFY_OK", actualSha256: descriptor.sha256 });
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    fireEvent.click(await screen.findByText("File options"));
    const check = await screen.findByRole("button", { name: "Check downloaded file" });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    // The canonical verify drops the false install and explains that the file
    // is gone; the honest next step is to download it again.
    await screen.findByText("Needs repair");
    expect(service.manager.statusOf(descriptor.modelId)?.checksumVerified).toBe(false);
    expect(screen.getByRole("button", { name: "Download again" })).toBeTruthy();
  });
  it("fails closed when disk reconciliation cannot check the files", async () => {
    const { service } = device({ failStorage: true });
    await service.ready;
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    await screen.findByText("Couldn't check the downloaded files on this device.");
    expect(screen.queryByText("Not downloaded")).toBeNull();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
  it("does not offer a download on an incompatible device", async () => {
    const { service } = device({ abi: "x86_64" });
    await service.ready;
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    await screen.findByText("Unavailable on this device.");
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
  it("still reports a verified file as installed when the device cannot run it", async () => {
    const { service } = device({ abi: "x86_64" });
    await service.ready;
    service.manager.dispatch(descriptor.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(descriptor.modelId, { type: "START" });
    service.manager.dispatch(descriptor.modelId, { type: "VERIFY_START" });
    service.manager.dispatch(descriptor.modelId, { type: "VERIFY_OK", actualSha256: descriptor.sha256 });
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    // The device verdict is the state line; it is not contradicted by a
    // second line underneath, and the verified file stays "Installed".
    await screen.findByText("Installed · unavailable on this device");
    expect(screen.getByRole("button", { name: "Remove local search helper" })).toBeTruthy();
  });
  it("keeps the removal confirmation open on failure without leaking native errors", async () => {
    const { service } = device();
    await service.ready;
    service.manager.dispatch(descriptor.modelId, { type: "FAIL", reason: "transfer failed" });
    const remove = vi.spyOn(service, "remove").mockRejectedValue(new Error("private runtime busy /private/models"));
    render(<MemoryRouter><DownloadedModels service={service} /></MemoryRouter>);
    const trigger = await screen.findByRole("button", { name: "Remove local search helper" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove helper" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "This tool is in use. Try again when it has finished.");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(service.manager.statusOf(descriptor.modelId)?.download).toBe("failed");
    expect(screen.queryByText(/local search helper removed/i)).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
