// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService, DOWNLOAD_MODELS } from "../services/ai/applicationAi";
import { Help } from "./Help";
import { assistantModeKey } from "./AiModels";
import { resetBackInterceptors } from "../components/backNavigation";

const state = vi.hoisted(() => ({ service: null as ApplicationAiService | null }));
vi.mock("../services/ai/applicationAi", async (original) => ({
  ...await original<typeof import("../services/ai/applicationAi")>(),
  getApplicationAi: () => state.service!,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-offline", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));
afterEach(() => {
  cleanup(); resetBackInterceptors(); window.localStorage.clear();
  document.body.style.overflow = ""; vi.restoreAllMocks();
});

it("Help picker → registry → shared installed Needle → native extraction sends without a key or cloud", async () => {
  Element.prototype.scrollIntoView ??= function () {};
  const files = new Map<string, string>();
  const inputs: string[] = [];
  let resident = false;
  state.service = new ApplicationAiService({ android: true, driver: {
    rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
    stagedSize: async () => 0, readJournalText: async () => null,
    download: async (attempt) => {
      files.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    }, cancelDownload: async () => {},
    hashFile: async (path) => files.get(path) ?? "", promoteFile: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    removeFile: async (path) => { files.delete(path); },
  }, needle: {
    bridgeName: "needle-cact", isNeedleAvailable: async () => resident,
    loadModel: async () => { resident = true; return 2; }, embeddingDimension: async () => 2,
    embedNeedleTexts: async (texts) => texts.map(() => [1, 0]), initTools: async () => {},
    completeJson: async (input) => {
      inputs.push(input);
      return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
    }, unload: async () => { resident = false; },
  }, smol: {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
  } });
  await state.service.ready;
  await state.service.download(DOWNLOAD_MODELS[0].modelId);
  window.localStorage.setItem(assistantModeKey("u-offline"), "offline-only");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Cloud forbidden"); });
  render(<MemoryRouter><Help /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
  const model = await screen.findByText(DOWNLOAD_MODELS[0].modelId);
  fireEvent.click(within(model.closest("li")!).getByRole("button", { name: /^select$/i }));
  const question = "Found a red umbrella near the library";
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText(/"title":"red umbrella"/);
  expect(inputs).toContain(question);
  expect(network).not.toHaveBeenCalled();
  expect(screen.queryByText(/built-in answer/i)).toBeNull();
});
