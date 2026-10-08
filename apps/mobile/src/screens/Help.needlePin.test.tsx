// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";
import { SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";

const state = vi.hoisted(() => ({ service: null as ApplicationAiService | null }));
vi.mock("../services/ai/applicationAi", async (original) => ({
  ...(await original<typeof import("../services/ai/applicationAi")>()),
  getApplicationAi: () => state.service!,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-needle-pin", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  window.localStorage.clear();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

async function installNeedle(withSmol = false) {
  Element.prototype.scrollIntoView ??= function () {};
  const files = new Map<string, string>();
  let resident = false;
  const completeJson = vi.fn(async () => JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "x" } }] }));
  const describeImage = vi.fn(async function* () {});
  state.service = new ApplicationAiService({
    android: true,
    driver: {
      rootDir: async () => "/private/ai-models",
      freeBytes: async () => 2e9,
      stagedSize: async () => 0,
      readJournalText: async () => null,
      download: async (attempt) => {
        files.set(attempt.stagingPath, attempt.expectedSha256);
        return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
      },
      cancelDownload: async () => {},
      hashFile: async (path) => files.get(path) ?? "",
      promoteFile: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      removeFile: async (path) => {
        files.delete(path);
      },
    },
    needle: {
      bridgeName: "needle-cact",
      isNeedleAvailable: async () => resident,
      loadModel: async () => {
        resident = true;
        return 2;
      },
      embeddingDimension: async () => 2,
      embedNeedleTexts: async (texts) => texts.map(() => [1, 0]),
      initTools: async () => {},
      completeJson,
      unload: async () => {
        resident = false;
      },
    },
    smol: {
      bridgeName: "smolvlm2-litertlm",
      isVisionAvailable: async () => false,
      loadVisionModel: async () => {},
      unloadVisionModel: async () => {},
      cancelGeneration: async () => {},
      describeImage,
      collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
    },
  });
  await state.service.ready;
  await state.service.download(NEEDLE_MODEL_ID);
  if (withSmol) await state.service.download(SMOL_VISION_MODEL_ID);
  return { completeJson, describeImage };
}

it.each([
  [false, "automatic"], [true, "automatic"],
  [false, "on-device-only"], [true, "on-device-only"],
])("Automatic text with Smol=%s in %s uses built-in guidance, never extraction or vision", async (withSmol, mode) => {
  const native = await installNeedle(Boolean(withSmol));
  localStorage.setItem("findback.ai.preferences.v1.u-needle-pin", JSON.stringify({ assistantMode: mode }));
  const getKey = vi.fn(async () => null);
  render(<MemoryRouter><Help deps={{ getKey }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "How do I report a lost wallet?" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText(/To report an item, open the Report tab/);
  expect(native.completeJson).not.toHaveBeenCalled();
  expect(native.describeImage).not.toHaveBeenCalled();
  if (mode === "on-device-only") expect(getKey).not.toHaveBeenCalled();
});

it("a stale Needle chat pin refuses honestly instead of answering chat through the tool engine", async () => {
  await installNeedle();
  window.localStorage.setItem(
    "findback.ai.preferences.v1.u-needle-pin",
    JSON.stringify({ preferredAssistantModel: NEEDLE_MODEL_ID }),
  );
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Cloud forbidden");
  });
  render(
    <MemoryRouter>
      <Help deps={{ getKey: async () => "forbidden" }} />
    </MemoryRouter>,
  );
  const question = "What should I include in my report?";
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText(/runs automatically in the background/i);
  // Draft kept for retry; nothing extracted through chat; no cloud contact.
  expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", question);
  expect(network).not.toHaveBeenCalled();
});

it("the assistant picker offers Automatic first and never lists the installed tool engine", async () => {
  await installNeedle();
  render(
    <MemoryRouter>
      <Help deps={{ getKey: async () => "test-key" }} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTestId("composer-model-chip"));
  await screen.findByTestId("model-picker");
  expect(screen.getByTestId("model-pick-automatic")).toBeTruthy();
  expect(screen.queryByText(NEEDLE_MODEL_ID)).toBeNull();
  expect(screen.getByTestId("model-manage-link")).toBeTruthy();
});
