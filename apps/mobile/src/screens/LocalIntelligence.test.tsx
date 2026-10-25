// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR } from "../services/ai/modelDescriptors";
import { LocalIntelligence } from "./LocalIntelligence";

afterEach(cleanup);

function nativeService() {
  return new ApplicationAiService({ android: true, driver: {
    supportedAbis: async () => ["arm64-v8a"],
    rootDir: async () => "/private/models", freeBytes: async () => 2e9,
    stagedSize: async () => 0, readJournalText: async () => null,
    download: async () => { throw new Error("Unexpected transfer"); },
    cancelDownload: async () => {}, hashFile: async () => { throw new Error("missing"); },
    promoteFile: async () => {}, removeFile: async () => {},
  }, needle: {
    bridgeName: "needle-cact", unload: async () => {}, isNeedleAvailable: async () => false,
    loadModel: async () => 2, embeddingDimension: async () => 2, embedNeedleTexts: async () => [],
    initTools: async () => {}, completeJson: async () => "{}",
  }, smol: {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
  } });
}

describe("Local intelligence", () => {
  it("shows ordinary search fallback and honest Android availability without downloads", async () => {
    const service = new ApplicationAiService({ android: false });
    const download = vi.spyOn(service, "download");
    render(<MemoryRouter><LocalIntelligence service={service} /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Local intelligence", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Downloads need the Android app.")).toBeTruthy();
    expect(screen.getByText(/normal search works without this helper/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Downloaded models" }).getAttribute("href")).toBe("/settings/local-intelligence/downloads");
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.getByText(/photo matching isn't available/i)).toBeTruthy();
    // Possible Matches weighs text, category, date and location — not photos.
    expect(screen.getByText(/text, category, date and location/i)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
  it("subscribes to verified helper state without exposing rejected models or lab controls", async () => {
    const service = nativeService();
    await service.ready;
    const { container } = render(<MemoryRouter><LocalIntelligence service={service} /></MemoryRouter>);
    await screen.findByText("Not downloaded");
    act(() => {
      service.manager.dispatch(NEEDLE_DESCRIPTOR.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      service.manager.dispatch(NEEDLE_DESCRIPTOR.modelId, { type: "START" });
      service.manager.dispatch(NEEDLE_DESCRIPTOR.modelId, { type: "VERIFY_START" });
      service.manager.dispatch(NEEDLE_DESCRIPTOR.modelId, { type: "VERIFY_OK", actualSha256: NEEDLE_DESCRIPTOR.sha256 });
    });
    expect(await screen.findByText("Installed")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Qwen|Smol|benchmark|runtime|checksum|Advanced|Balanced|Best/);
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
  it("does not leave a user stranded when the model store cannot be read", async () => {
    const service = nativeService();
    await service.ready;
    // The canonical storage-verification failure: the file store is unreadable.
    act(() => {
      service.manager.dispatch(NEEDLE_DESCRIPTOR.modelId, { type: "FAIL", reason: "Model storage could not be verified. Retry from AI & Models." });
    });
    render(<MemoryRouter><LocalIntelligence service={service} /></MemoryRouter>);
    await screen.findByText(/couldn't check the downloaded files/i);
    expect(screen.queryByText("Try reopening FindBack.")).toBeNull();
  });
  it("waits for compatibility instead of acting on the service's optimistic default", async () => {
    const service = nativeService();
    let finish!: () => void;
    vi.spyOn(service, "ensureCompatibility").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<MemoryRouter><LocalIntelligence service={service} /></MemoryRouter>);
    expect(screen.getByText("Checking downloads…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    await act(async () => finish());
    expect(await screen.findByRole("button", { name: "Download · 35.3 MB" })).toBeTruthy();
  });
});
