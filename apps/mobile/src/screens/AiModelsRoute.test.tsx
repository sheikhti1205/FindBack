// @vitest-environment jsdom
import { act } from "react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";
import { AiModelsRoute } from "./AiModelsRoute";
import { buildJournal } from "../services/ai/download/journal";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
afterEach(cleanup);

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
  let journal: string | null = null;
  const offsets: number[] = [];
  const service = new ApplicationAiService({ android: true, driver: {
    supportedAbis: async () => ["arm64-v8a"],
    rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
    stagedSize: async () => staged, readJournalText: async () => journal,
    download: async (attempt) => {
      offsets.push(attempt.resumeOffset);
      if (offsets.length === 1) {
        staged = 1024;
        journal = JSON.stringify(buildJournal({ url: attempt.url, filePath: attempt.fileName!, sha: attempt.expectedSha256, offset: staged, total: attempt.maxBytes, modelId: attempt.modelId, revision: attempt.revision }));
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
  }, qwenText: {
    bridgeName: "qwen3-litertlm-text", isTextAvailable: async () => true,
    loadTextModel: async () => {}, unloadTextModel: async () => {},
    cancelGeneration: async () => {}, generateText: async function* () { yield { textDelta: "hi" }; },
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
    expect(screen.getByRole("heading", { name: /photo analysis/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /download photo analysis/i })).toHaveLength(1);
    expectNormalTierCopy(view.container);
  });

  it("does not offer a second download owner for the local search helper", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    // The helper is downloaded and removed under Local intelligence only.
    expect(screen.queryByRole("heading", { name: /local text tools/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /download local text tools/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove local text tools/i })).toBeNull();
    // The catalogue points at that single owner instead of duplicating it.
    const pointer = screen.getByRole("link", { name: /local search helper/i });
    expect(pointer.getAttribute("href")).toBe("/settings/local-intelligence/downloads");
    expectNormalTierCopy(view.container);
  });

  it("production route connects progress, Pause, Resume, Ready and Remove to native storage", async () => {
    const { service, offsets } = androidService();
    await service.ready;
    const transitions: string[] = [];
    service.manager.subscribe(() => transitions.push(service.manager.statusOf(VISION)!.download));
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Download Photo analysis" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause Photo analysis" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume Photo analysis" }));
    await screen.findByText("Ready · 361 MB");
    expect(view.container.textContent).not.toContain("Installed and checksum verified.");
    expect(offsets).toEqual([0, 1024]);
    expect(transitions).toContain("verifying");
    expect(service.manager.statusOf(VISION)?.checksumVerified).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Photo analysis" }));
    await screen.findByRole("button", { name: "Download Photo analysis" });
    expect(service.manager.statusOf(VISION)?.download).toBe("not-installed");
    expectNormalTierCopy(view.container);
  });

  it("shows downloading percent with pause and ready size without raw bytes", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    act(() => {
      service.manager.dispatch(VISION, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      service.manager.dispatch(VISION, { type: "START" });
      service.manager.dispatch(VISION, {
        type: "PROGRESS",
        downloadedBytes: Math.round(SMOL_VISION_DESCRIPTOR.bytes * 0.42),
      });
    });
    expect(await screen.findByText("Downloading 42%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause Photo analysis" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /photo analysis download progress/i })).toBeTruthy();
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
  it("offers no benchmark, performance or engineering route on the consumer page", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    // Positive anchor first: the catalogue itself still renders.
    await waitFor(() => expect(view.container.textContent).toContain("Photo analysis"));
    for (const name of [/measure performance/i, /advanced/i, /performance/i, /diagnostics/i]) {
      expect(screen.queryAllByRole("link", { name })).toHaveLength(0);
      expect(screen.queryAllByRole("button", { name })).toHaveLength(0);
    }
    for (const route of view.container.querySelectorAll("a[href]")) {
      expect(route.getAttribute("href")).not.toMatch(/advanced|performance|diagnostics|__/);
    }
    expectNormalTierCopy(view.container);
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
    // The catalogue's own Recommended cards name the state once facts load.
    // (The local search helper is owned by Local intelligence, not here.)
    expect(await screen.findAllByText("Unavailable on this device.")).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: /download/i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect((button as HTMLButtonElement).title).toBe("Unavailable on this device.");
    }
    expectNormalTierCopy(view.container);
  });

  it("offers only the verified consumer catalogue, never the lab tier", async () => {
    const extra = {
      modelId: "test-extra-model", displayName: "Test extra", consumerTitle: "Test extra",
      consumerDetail: "Test", runtimeId: "test-extra-runtime", format: "cact" as const,
      revision: "rev1", sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      fileName: "extra.cact", url: "https://example.invalid/extra.cact", bytes: 1024,
      capabilities: ["text"] as const, taskRoles: [], maturity: "production" as const,
      trust: "curated" as const, license: "test-only", minRamMb: 512, recommendedRamMb: 512,
      abis: ["arm64-v8a"], downloadable: true,
    };
    const lab = { ...extra, modelId: "test-lab-model", displayName: "Lab hidden", consumerTitle: "Lab hidden", maturity: "lab" as const, downloadable: false };
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
    // Lab metadata is not in the ordinary consumer tier, and the consumer
    // route no longer carries any engineering disclosure that could reach it.
    expect(screen.queryByRole("heading", { name: "Lab hidden" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Lab hidden" })).toBeNull();
    expectNormalTierCopy(view.container);
  });

  it("never offers model import, URL/mirror entry or evaluation on the consumer route", async () => {
    const { service } = androidService();
    await service.ready;
    const view = render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
    // Consumer rows keep their plain title, role summary and download action.
    expect(await screen.findByRole("heading", { name: /on-device assistant/i })).toBeTruthy();
    // Qwen-only install is a chat model: report filling belongs to Needle.
    expect(screen.getByText("Answers questions")).toBeTruthy();
    expect(screen.queryByText("Answers questions · Fills in reports")).toBeNull();
    expect(screen.getByRole("button", { name: "Download On-device assistant" })).toBeTruthy();
    // Packet 07 §20 / 13 "REMOVE FROM CONSUMER": none of the acquisition or
    // evaluation controls may be reachable from a consumer screen.
    for (const name of [
      "Open Advanced",
      "Import model files",
      "Import local file",
      "Import URL",
      "Download model",
      "Run evaluation",
      "Choose evaluation photo",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("Evaluation prompt")).toBeNull();
    expect(screen.queryByLabelText("Expected SHA-256")).toBeNull();
    expect(screen.queryByLabelText("Exact byte count")).toBeNull();
    expect(screen.queryByLabelText("Model URL")).toBeNull();
    // Engineering tooling routes must never be linked from a consumer page
    // (packet 07 §20, 13 "REMOVE FROM CONSUMER"). Guards reintroduction.
    expect(view.container.querySelector('a[href*="__model-supply"]')).toBeNull();
    expectNormalTierCopy(view.container);
  });
});
