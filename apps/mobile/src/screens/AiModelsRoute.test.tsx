// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationAiService, DOWNLOAD_MODELS } from "../services/ai/applicationAi";
import { AiModelsRoute } from "./AiModelsRoute";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
afterEach(cleanup);
it("production route connects progress, Pause, Resume, Verify, Install and Remove to native storage", async () => {
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
  } });
  await service.ready;
  const transitions: string[] = [];
  service.manager.subscribe(() => transitions.push(service.manager.statusOf(DOWNLOAD_MODELS[0].modelId)!.download));
  render(<MemoryRouter><AiModelsRoute service={service} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Download on-device model" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause download" }));
  fireEvent.click(await screen.findByRole("button", { name: "Resume download" }));
  await screen.findByText("Installed and checksum verified.");
  expect(offsets).toEqual([0, 1024]);
  expect(transitions).toContain("verifying");
  expect(service.manager.statusOf(DOWNLOAD_MODELS[0].modelId)?.checksumVerified).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove on-device model" }));
  await screen.findByRole("button", { name: "Download on-device model" });
  expect(service.manager.statusOf(DOWNLOAD_MODELS[0].modelId)?.download).toBe("not-installed");
});
