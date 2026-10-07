// @vitest-environment jsdom
import { act } from "react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";
import { AiModelsRoute } from "./AiModelsRoute";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
afterEach(cleanup);

const NEEDLE = NEEDLE_MODEL_ID;
const VISION = SMOL_VISION_MODEL_ID;

const FORBIDDEN = [
  "checksum",
  "runtime",
  "backend",
  "transport",
  "schema",
  "device_required",
  "challenger",
  "fresh passing measurement",
  "device required",
];

function expectNormalTierCopy(container: HTMLElement) {
  const text = (container.textContent ?? "").toLowerCase();
  for (const term of FORBIDDEN) {
    expect(text).not.toContain(term);
  }
  expect(text).not.toMatch(/[0-9a-f]{16,}/);
}

function androidService() {
  const files = new Map<string, string>();
  let staged = 0;
  const offsets: number[] = [];
  const service = new ApplicationAiService({ android: true, driver: {
    rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
    stagedSize: async () => staged, readJournalText: async () => null,
    download: async (attempt) => {
      offsets.push(attempt.resumeOffset);
      if (offsets.length === 1) {
        staged = 1024;
        attempt.onProgress?.(staged, attempt.maxBytes);
        await new Promise<void>((_, reject) => {
          attempt.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }
      files.set(attempt.stagingPath, attempt.expectedSha256);
      attempt.onProgress?.(attempt.maxBytes - attempt.resumeOffset, attempt.maxBytes);
      return { receivedBytes: attempt.maxBytes - attempt.resumeOffset, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    }, cancelDownload: async () => {},
    hashFile: async (path) => { if (!files.has(path)) throw new Error("missing"); return files.get(path)!; },
    promoteFile: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    removeFile: async (path) => { files.delete(path); },
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
  return { service, offsets };
}

describe("AiModelsRoute consumer cards", () => {
  it("names consumer tools with model names as secondary detail only", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/on-device ai/i);
    expect(screen.getByRole("heading", { name: /local text tools/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /photo analysis/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /download local text tools/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /download photo analysis/i })).toHaveLength(1);
    expectNormalTierCopy(view.container);
  });

  it("production route connects progress, Pause, Resume, Ready and Remove to native storage", async () => {
    const { service, offsets } = androidService();
    await service.ready;
    const transitions: string[] = [];
    service.manager.subscribe(() => transitions.push(service.manager.statusOf(NEEDLE)!.download));
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Download Local text tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause Local text tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume Local text tools" }));
    await screen.findByText("Ready · 35 MB");
    expect(view.container.textContent).not.toContain("Installed and checksum verified.");
    expect(offsets).toEqual([0, 1024]);
    expect(transitions).toContain("verifying");
    expect(service.manager.statusOf(NEEDLE)?.checksumVerified).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Local text tools" }));
    await screen.findByRole("button", { name: "Download Local text tools" });
    expect(service.manager.statusOf(NEEDLE)?.download).toBe("not-installed");
    expectNormalTierCopy(view.container);
  });

  it("shows downloading percent with pause and ready size without raw bytes", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    act(() => {
      service.manager.dispatch(NEEDLE, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      service.manager.dispatch(NEEDLE, { type: "START" });
      service.manager.dispatch(NEEDLE, {
        type: "PROGRESS",
        downloadedBytes: Math.round(NEEDLE_DESCRIPTOR.bytes * 0.42),
      });
    });
    expect(await screen.findByText("Downloading 42%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause Local text tools" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /local text tools download progress/i })).toBeTruthy();
    expectNormalTierCopy(view.container);
  });

  it("shows needs more storage instead of a storage failure dump", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    act(() => {
      service.manager.dispatch(VISION, { type: "FAIL", reason: "not enough free storage for this download" });
    });
    expect(await screen.findByText("Needs more storage")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Photo analysis" })).toBeTruthy();
    expectNormalTierCopy(view.container);
  });

  it("retries a failed download with its notice intact", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    act(() => {
      service.manager.dispatch(VISION, { type: "FAIL", reason: "transfer failed" });
    });
    expect(await screen.findByRole("button", { name: "Download Photo analysis" })).toBeTruthy();
    // Normal tier translates the engineering reason; the raw wording stays out.
    expect(screen.getByText("The download was interrupted. Try again.")).toBeTruthy();
    expect(view.container.textContent ?? "").not.toContain("transfer failed");
    expectNormalTierCopy(view.container);
  });

  it("stays honest without native support", async () => {
    const webService = new ApplicationAiService({ android: false });
    await webService.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={webService} /></MemoryRouter>);
    expect(screen.getByText(/needs the android app/i)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: /download/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expectNormalTierCopy(view.container);
  });
  it("uses the safest-option line until performance is measured on this phone", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    expect(
      screen.getByText(
        /findback uses the safest available option until performance has been measured on this phone/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /measure performance/i }).getAttribute("href")).toBe(
      "/settings/ai/advanced",
    );
    expectNormalTierCopy(view.container);
    await waitFor(() => expect(view.container.textContent).toContain("Local text tools"));
  });

  it("names an incompatible device instead of offering a dead download", async () => {
    const service = new ApplicationAiService({
      android: true,
      driver: {
        rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
        stagedSize: async () => 0, readJournalText: async () => null,
        download: async () => { throw new Error("must never start"); },
        cancelDownload: async () => {}, hashFile: async () => { throw new Error("missing"); },
        promoteFile: async () => {}, removeFile: async () => {},
      },
      needle: {
        bridgeName: "needle-cact", unload: async () => {}, isNeedleAvailable: async () => false,
        loadModel: async () => 2, embeddingDimension: async () => 2, embedNeedleTexts: async () => [],
        initTools: async () => {}, completeJson: async () => "{}",
      },
      smol: {
        bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
        loadVisionModel: async () => {}, unloadVisionModel: async () => {},
        cancelGeneration: async () => {}, describeImage: async function* () {},
        collectDeviceFacts: async () => ({ supportedAbis: ["x86_64"] }),
      },
    });
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    // Both production cards name the state once facts load.
    expect(await screen.findAllByText("Unavailable on this device.")).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: /download/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect((button as HTMLButtonElement).title).toBe("Unavailable on this device.");
    }
    expectNormalTierCopy(view.container);
  });

  it("renders catalogue descriptors, never lab entries, with no hard-coded cards", async () => {
    const extra = {
      modelId: "test-extra-model", displayName: "Test extra", consumerTitle: "Test extra",
      consumerDetail: "Test", runtimeId: "test-extra-runtime", format: "cact" as const,
      revision: "rev1", sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      fileName: "extra.cact", url: "https://example.invalid/extra.cact", bytes: 1024,
      capabilities: ["text"] as const, taskRoles: [], maturity: "production" as const,
      trust: "curated" as const, license: "test-only", minRamMb: 512, recommendedRamMb: 512,
      abis: ["arm64-v8a"], downloadable: true,
    };
    const lab = { ...extra, modelId: "test-lab-model", consumerTitle: "Lab hidden", downloadable: false };
    const service = new ApplicationAiService({
      android: true,
      driver: {
        rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
        stagedSize: async () => 0, readJournalText: async () => null,
        download: async () => { throw new Error("unexpected download"); },
        cancelDownload: async () => {}, hashFile: async () => { throw new Error("missing"); },
        promoteFile: async () => {}, removeFile: async () => {},
      },
      needle: {
        bridgeName: "needle-cact", unload: async () => {}, isNeedleAvailable: async () => false,
        loadModel: async () => 2, embeddingDimension: async () => 2, embedNeedleTexts: async () => [],
        initTools: async () => {}, completeJson: async () => "{}",
      },
      smol: {
        bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
        loadVisionModel: async () => {}, unloadVisionModel: async () => {},
        cancelGeneration: async () => {}, describeImage: async function* () {},
        collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
      },
      descriptors: [NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, extra, lab],
      defaultVisionModelId: SMOL_VISION_MODEL_ID,
    });
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Test extra" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Test extra" })).toBeTruthy();
    expect(view.container.textContent ?? "").not.toContain("Lab hidden");
    expectNormalTierCopy(view.container);
  });
});
