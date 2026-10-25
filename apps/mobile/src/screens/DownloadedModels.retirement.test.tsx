// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR, QWEN_TEXT_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, type ModelDescriptor } from "../services/ai/modelDescriptors";
import type { ModelDownloadDriver } from "../services/ai/download/driver";
import { importedDescriptor, type ImportSpec } from "../services/ai/download/import";
import { DownloadedModels } from "./DownloadedModels";

afterEach(cleanup);

function fixture(descriptors?: readonly ModelDescriptor[], previousImports: readonly ImportSpec[] = []) {
  const disk = new Map<string, string>();
  let metadata = JSON.stringify(previousImports);
  for (const old of previousImports) {
    const d = importedDescriptor(old);
    disk.set(`/private/models/models/${d.modelId}/${d.revision}/${d.fileName}`, d.sha256);
  }
  const removed: string[] = [];
  const unloadNeedle = vi.fn(async () => {});
  const driver: ModelDownloadDriver = {
    supportedAbis: async () => ["arm64-v8a"], rootDir: async () => "/private/models", freeBytes: async () => 1e10,
    stagedSize: async () => 0, readJournalText: async () => null,
    download: async () => { throw new Error("No download expected"); },
    readMetadata: async () => metadata, writeMetadata: async (_path, value) => { metadata = value; },
    pickAndStage: async ({ stagingPath }) => { disk.set(stagingPath, "a".repeat(64)); return { actualHex: "a".repeat(64), bytes: 12 }; },
    hashFile: async (path) => disk.get(path) ?? "",
    cancelDownload: async () => {},
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { removed.push(path); for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key); },
  };
  const service = new ApplicationAiService({ android: true, driver, descriptors,
    needle: { bridgeName: "needle-cact", isNeedleAvailable: async () => false, unload: unloadNeedle, loadModel: async () => 2, embeddingDimension: async () => 2, embedNeedleTexts: async () => [], initTools: async () => {}, completeJson: async () => "{}" },
    smol: { bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false, loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {}, describeImage: async function* () {} },
    qwenText: { bridgeName: "qwen3-litertlm-text", isTextAvailable: async () => false, loadTextModel: async () => {}, unloadTextModel: async () => {}, cancelGeneration: async () => {}, generateText: async function* () {} },
    llama: { bridgeName: "llama-cpp-lab", isLlamaAvailable: async () => false, loadLlamaModel: async () => {}, unloadLlamaModel: async () => {}, cancelGeneration: async () => {}, inferLlama: async function* () {} },
  });
  function seed(d: ModelDescriptor, state: "installed" | "partial" = "installed") {
    const paths = service.manager.stagingPathsFor("/private/models", d.modelId, d.revision, d.fileName);
    disk.set(state === "installed" ? paths.installedPath : paths.stagingPath, d.sha256);
    service.manager.dispatch(d.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(d.modelId, { type: "START" });
    if (state === "installed") {
      service.manager.dispatch(d.modelId, { type: "VERIFY_START" });
      service.manager.dispatch(d.modelId, { type: "VERIFY_OK", actualSha256: d.sha256 });
    } else {
      service.manager.dispatch(d.modelId, { type: "PROGRESS", downloadedBytes: 12 });
      service.manager.dispatch(d.modelId, { type: "CANCEL" });
    }
  }
  return { service, driver, disk, removed, seed, unloadNeedle };
}

async function openCleanup() {
  const trigger = await screen.findByRole("button", { name: "Remove older downloads" });
  trigger.focus(); // fireEvent.click does not perform the browser's focus default.
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "Remove older downloads?" });
}

it("does not advertise obsolete models or cleanup on a clean installation", async () => {
  const f = fixture(); await f.service.ready;
  const { container } = render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  await screen.findByText("Not downloaded");
  expect(screen.queryByRole("button", { name: "Remove older downloads" })).toBeNull();
  expect(container.textContent).not.toMatch(/other on-device models|Qwen|Smol|photo analysis|catalogue/i);
});

it("removes old installed and partial downloads only after consent, preserving the installed helper", async () => {
  const f = fixture(); await f.service.ready;
  f.seed(NEEDLE_DESCRIPTOR); f.seed(QWEN_TEXT_DESCRIPTOR); f.seed(SMOL_VISION_DESCRIPTOR, "partial");
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  const dialog = await openCleanup();
  expect(within(dialog).getByText(/search helper.*stay/i)).toBeTruthy();
  expect(f.removed).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep downloads" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove older downloads" }));
  expect(f.removed).toEqual([]);
  const confirmed = await openCleanup();
  fireEvent.click(within(confirmed).getByRole("button", { name: "Remove older downloads" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const result = screen.getByText("Older downloads removed. Your local search helper is unchanged.");
  expect(document.activeElement).toBe(result);
  expect(f.service.manager.statusOf(QWEN_TEXT_DESCRIPTOR.modelId)?.download).toBe("not-installed");
  expect(f.service.manager.statusOf(SMOL_VISION_DESCRIPTOR.modelId)?.download).toBe("not-installed");
  expect(f.service.manager.statusOf(NEEDLE_DESCRIPTOR.modelId)?.checksumVerified).toBe(true);
  expect(f.unloadNeedle).not.toHaveBeenCalled();
  expect([...f.disk.values()]).toEqual([NEEDLE_DESCRIPTOR.sha256]);
});

it("does not duplicate or dismiss an in-flight cleanup", async () => {
  const f = fixture(); await f.service.ready; f.seed(QWEN_TEXT_DESCRIPTOR);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const remove = vi.spyOn(f.service, "remove").mockImplementation(async () => { await held; });
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  const dialog = await openCleanup();
  const confirm = within(dialog).getByRole("button", { name: "Remove older downloads" });
  fireEvent.click(confirm); fireEvent.click(confirm); fireEvent.keyDown(document, { key: "Escape" });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => { release(); await held; });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps partial cleanup retryable without leaking native errors or removing the helper", async () => {
  const f = fixture(); await f.service.ready;
  f.seed(NEEDLE_DESCRIPTOR); f.seed(SMOL_VISION_DESCRIPTOR); f.seed(QWEN_TEXT_DESCRIPTOR);
  const realRemove = f.driver.removeFile;
  let fail = true;
  f.driver.removeFile = async (path) => { if (fail && path.includes(QWEN_TEXT_DESCRIPTOR.modelId)) throw new Error("private path /data/files qwen ABI"); await realRemove(path); };
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  const dialog = await openCleanup();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove older downloads" }));
  const error = await within(dialog).findByRole("alert");
  expect(error.textContent).not.toMatch(/qwen|ABI|\/data|private/i);
  expect(screen.queryByText("Older downloads removed. Your local search helper is unchanged.")).toBeNull();
  expect(f.service.manager.statusOf(QWEN_TEXT_DESCRIPTOR.modelId)?.download).toBe("failed");
  expect(f.service.manager.statusOf(SMOL_VISION_DESCRIPTOR.modelId)?.download).toBe("not-installed");
  fail = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove older downloads" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.service.manager.statusOf(NEEDLE_DESCRIPTOR.modelId)?.checksumVerified).toBe(true);
  expect(f.unloadNeedle).not.toHaveBeenCalled();
});

it("does not retire future narrow-tool runtimes or offer clean generative descriptors for deletion", async () => {
  const future = { ...NEEDLE_DESCRIPTOR, modelId: "future-narrow-tool", runtimeId: "future-narrow-runtime" };
  const f = fixture([NEEDLE_DESCRIPTOR, QWEN_TEXT_DESCRIPTOR, future]); await f.service.ready;
  f.seed(future); f.seed(NEEDLE_DESCRIPTOR);
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  await screen.findByText("Installed");
  expect(screen.queryByRole("button", { name: "Remove older downloads" })).toBeNull();
  expect(f.removed).toEqual([]);
  expect(f.service.manager.statusOf(future.modelId)?.checksumVerified).toBe(true);
});

it("includes a previously failed generative transfer and allows Escape cancellation", async () => {
  const f = fixture(); await f.service.ready;
  f.seed(QWEN_TEXT_DESCRIPTOR, "partial");
  f.service.manager.dispatch(QWEN_TEXT_DESCRIPTOR.modelId, { type: "FAIL", reason: "transfer failed" });
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  await openCleanup();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.removed).toEqual([]);
  const confirmed = await openCleanup();
  fireEvent.click(within(confirmed).getByRole("button", { name: "Remove older downloads" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.disk.size).toBe(0);
});

it("allows cleanup of previously imported generative files without showing an import or acquisition UI", async () => {
  const f = fixture(undefined, [{ sha256: "a".repeat(64), bytes: 12, format: "gguf", license: "Apache-2.0" }]);
  await f.service.ready;
  const imported = `imported-${"a".repeat(64)}`;
  expect(f.service.manager.statusOf(imported)?.checksumVerified).toBe(true);
  render(<MemoryRouter><DownloadedModels service={f.service} /></MemoryRouter>);
  const dialog = await openCleanup();
  expect(dialog.textContent).not.toMatch(/imported-|llama|gguf|runtime|SHA/i);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove older downloads" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.service.registry.descriptorFor(imported)).toBeUndefined();
  expect([...f.disk.keys()].some((path) => path.includes(imported))).toBe(false);
});
