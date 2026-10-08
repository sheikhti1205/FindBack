// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";
import { SMOL_VISION_MODEL_ID } from "../services/ai/modelDescriptors";
import { Help, type HelpAssistantDeps } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import { aiCredentials } from "../services/aiCredentials";
import { buildPng } from "../services/media/__fixtures__/synthetic";
import type { OfflineVisionRequest } from "../services/ai/providers/offline";

const state = vi.hoisted(() => ({ service: null as ApplicationAiService | null }));
vi.mock("../services/ai/applicationAi", async (original) => ({
  ...await original<typeof import("../services/ai/applicationAi")>(),
  getApplicationAi: () => state.service!,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-offline", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(() => {
  cleanup(); resetBackInterceptors(); window.localStorage.clear();
  document.body.style.overflow = "";
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const approvedPng = buildPng(4, 4);
const approvedBase64 = btoa(String.fromCharCode(...approvedPng));
const importDeps: NonNullable<HelpAssistantDeps["importDeps"]> = {
  transcode: async () => approvedPng,
  webpEncodeSupported: false,
};
const appQuestion = "How do I report a lost wallet?";
const generalQuestion = "Help me solve a leetcode problem: two sum";

function preferences(assistantMode: "automatic" | "on-device-only" | "cloud-only", preferredAssistantModel: string | null = null) {
  localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode, preferredAssistantModel }));
}
function renderHelp(deps: HelpAssistantDeps = {}) {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:offline-photo"; }
    static revokeObjectURL() {}
  });
  return render(<MemoryRouter><Help deps={{ importDeps, ...deps }} /></MemoryRouter>);
}
function composer() { return screen.getByLabelText("Ask the Help & FAQ") as HTMLTextAreaElement; }
function send(question: string) {
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}
async function attachPng() {
  fireEvent.change(screen.getByTestId("chat-file-input"), {
    target: { files: [new File([approvedPng as unknown as BlobPart], "wallet.png", { type: "image/png" })] },
  });
  await screen.findByTestId("chat-selections");
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function forbidCloud() {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Cloud forbidden"); });
  const keys = vi.spyOn(aiCredentials, "get");
  const getKey = vi.fn(async () => "must never read");
  return { network, keys, getKey };
}
function expectNoCloud(cloud: ReturnType<typeof forbidCloud>) {
  expect(cloud.network).not.toHaveBeenCalled();
  expect(cloud.keys).not.toHaveBeenCalled();
  expect(cloud.getKey).not.toHaveBeenCalled();
}

// Real application service, manager, checksum install and offline adapter;
// only the disk/download/native platform boundaries are in-memory fakes.
async function installModels(withSmol = false, options: { failVision?: boolean; waitVision?: Promise<void> } = {}) {
  const files = new Map<string, string>();
  let needleResident = false;
  let visionResident = false;
  const completeJson = vi.fn(async (_input: string) => JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "Keys" } }] }));
  const describeImage = vi.fn(async function* (_request: OfflineVisionRequest, _signal: AbortSignal) {
    await options.waitVision;
    if (options.failVision) throw new Error("Native vision failed");
    yield { textDelta: "A red wallet on a desk." };
  });
  const cancelGeneration = vi.fn(async () => {});
  const loadVisionModel = vi.fn(async () => { visionResident = true; });
  state.service = new ApplicationAiService({ android: true, driver: {
    rootDir: async () => "/private/ai-models", freeBytes: async () => 2e9,
    stagedSize: async () => 0, readJournalText: async () => null,
    download: async (attempt) => {
      files.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    }, cancelDownload: async () => {},
    hashFile: async (path) => files.get(path) ?? "",
    promoteFile: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    removeFile: async (path) => { files.delete(path); },
  }, needle: {
    bridgeName: "needle-cact", isNeedleAvailable: async () => needleResident,
    loadModel: async () => { needleResident = true; return 2; }, embeddingDimension: async () => 2,
    embedNeedleTexts: async (texts) => texts.map(() => [1, 0]), initTools: async () => {},
    completeJson, unload: async () => { needleResident = false; },
  }, smol: {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => visionResident,
    loadVisionModel, unloadVisionModel: async () => { visionResident = false; },
    cancelGeneration, describeImage,
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
  } });
  await state.service.ready;
  await state.service.download(NEEDLE_MODEL_ID);
  if (withSmol) await state.service.download(SMOL_VISION_MODEL_ID);
  return { completeJson, describeImage, cancelGeneration, loadVisionModel };
}
function expectNoNativeChat(native: Awaited<ReturnType<typeof installModels>>) {
  expect(native.completeJson).not.toHaveBeenCalled();
  expect(native.describeImage).not.toHaveBeenCalled();
  expect(native.loadVisionModel).not.toHaveBeenCalled();
}

it.each([false, true])("Automatic text with Smol=%s uses allowed cloud prose, never either local engine", async (withSmol) => {
  const native = await installModels(withSmol);
  preferences("automatic");
  const getKey = vi.fn(async () => "test-key");
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    'data: {"choices":[{"delta":{"content":"Use a hash map for two sum."}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));
  renderHelp({ getKey });
  send(generalQuestion);
  await screen.findByText("Use a hash map for two sum.");
  expectNoNativeChat(native);
  expect(network).toHaveBeenCalledTimes(1);
  const [url, init] = network.mock.calls[0]!;
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(String(init?.body));
  expect(body.messages.at(-1)).toMatchObject({ role: "user", content: generalQuestion });
  expect(body.model).toBe("openrouter/free");
  expect(String(init?.body)).not.toContain("test-key");
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expect(composer().value).toBe("");
});

it.each([false, true])("on-device-only text with Smol=%s refuses unsupported general chat and keeps the draft", async (withSmol) => {
  const native = await installModels(withSmol);
  preferences("on-device-only");
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  send(generalQuestion);
  await screen.findByTestId("chat-error");
  expect(composer().value).toBe(generalQuestion);
  expect(screen.getByTestId("chat-retry")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
});

// Supported built-in text guidance for all four install/mode combinations
// is also covered by Help.needlePin.test.tsx; no tool JSON is a chat answer.
it.each(["automatic", "on-device-only"] as const)("%s discovers cold installed Smol for an approved image, not Needle", async (mode) => {
  const native = await installModels(true);
  preferences(mode);
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  await attachPng();
  const question = "What is in this photo?";
  send(question);
  await screen.findByText("A red wallet on a desk.");
  expect(native.completeJson).not.toHaveBeenCalled();
  expect(native.loadVisionModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: SMOL_VISION_MODEL_ID, backend: "cpu" }));
  expect(native.describeImage).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: approvedBase64, prompt: expect.stringContaining(question) }), expect.any(AbortSignal));
  expect(state.service!.residency.owner).toBe("smol-vision");
  expectNoCloud(cloud);
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expect(composer().value).toBe("");
  expect(screen.queryByTestId("chat-selections")).toBeNull();
});

it.each(["automatic", "on-device-only"] as const)("%s image with only Needle installed and no cloud key fails closed with draft and photo kept", async (mode) => {
  const native = await installModels();
  preferences(mode);
  const cloud = forbidCloud();
  const getKey = vi.fn(async () => null);
  renderHelp({ getKey });
  await attachPng();
  send("Describe my private photo");
  await screen.findByTestId("chat-error");
  expect(composer().value).toBe("Describe my private photo");
  expect(screen.getByTestId("chat-selections")).toBeTruthy();
  expect(screen.getByTestId("chat-retry")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
  if (mode === "on-device-only") expect(getKey).not.toHaveBeenCalled();
});

it.each(["automatic", "on-device-only"] as const)("%s image native failure never falls back to cloud or substitutes FAQ prose", async (mode) => {
  const native = await installModels(true, { failVision: true });
  preferences(mode);
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  await attachPng();
  send(appQuestion);
  await screen.findByTestId("chat-error");
  expect(native.describeImage).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: approvedBase64 }), expect.any(AbortSignal));
  expect(native.completeJson).not.toHaveBeenCalled();
  expect(composer().value).toBe(appQuestion);
  expect(screen.getByTestId("chat-selections")).toBeTruthy();
  expect(screen.getByTestId("chat-retry")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoCloud(cloud);
});

it.each(["automatic", "on-device-only"] as const)("%s keeps text pinned to image-only Smol rather than switching to cloud or built-in help", async (mode) => {
  const native = await installModels(true);
  preferences(mode, SMOL_VISION_MODEL_ID);
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  send(appQuestion);
  const error = await screen.findByTestId("chat-error");
  expect(error.textContent).toMatch(/needs an approved image|not qualified for text chat/i);
  expect(composer().value).toBe(appQuestion);
  expect(screen.getByTestId("chat-retry")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
});

it("a Needle pin with a photo stays refused even when compatible Smol is installed", async () => {
  const native = await installModels(true);
  preferences("automatic", NEEDLE_MODEL_ID);
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  await attachPng();
  send(appQuestion);
  const error = await screen.findByTestId("chat-error");
  expect(error.textContent).toMatch(/runs automatically in the background/i);
  expect(composer().value).toBe(appQuestion);
  expect(screen.getByTestId("chat-selections")).toBeTruthy();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
});

it("cloud-only skips installed local models for a text send", async () => {
  const native = await installModels(true);
  preferences("cloud-only");
  const getKey = vi.fn(async () => null);
  const network = vi.spyOn(globalThis, "fetch");
  renderHelp({ getKey });
  send(appQuestion);
  await screen.findByText(/To report an item, open the Report tab/);
  expect(screen.getByText("Built-in answer")).toBeTruthy();
  expectNoNativeChat(native);
  expect(getKey).toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it("switching to on-device-only during discovery refuses a general-chat draft before reading a cloud key", async () => {
  const native = await installModels(true);
  const gate = deferred();
  const cloud = forbidCloud();
  const listCatalog = vi.fn(async () => {
    await gate.promise;
    return state.service!.offlineAdapter().listModels();
  });
  renderHelp({ getKey: cloud.getKey, listCatalog });
  send(generalQuestion);
  await waitFor(() => expect(listCatalog).toHaveBeenCalled());
  preferences("on-device-only");
  await act(async () => { gate.release(); await gate.promise; });
  await screen.findByTestId("chat-error");
  expect(composer().value).toBe(generalQuestion);
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
});

it("stopping discovery blocks late catalogue settlement from starting native inference or cloud", async () => {
  const native = await installModels(true);
  const gate = deferred();
  const cloud = forbidCloud();
  const listCatalog = vi.fn(async () => {
    await gate.promise;
    return state.service!.offlineAdapter().listModels();
  });
  renderHelp({ getKey: cloud.getKey, listCatalog });
  await attachPng();
  send("Describe my private photo");
  await waitFor(() => expect(listCatalog).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("chat-stop"));
  await act(async () => { gate.release(); await gate.promise; });
  await screen.findByTestId("chat-cancelled");
  expect(composer().value).toBe("Describe my private photo");
  expect(screen.getByTestId("chat-selections")).toBeTruthy();
  expect(screen.queryByText("A red wallet on a desk.")).toBeNull();
  expectNoNativeChat(native);
  expectNoCloud(cloud);
});

it("a privacy change during key access keeps an app-help draft instead of sending or substituting a built-in answer", async () => {
  const native = await installModels(true);
  preferences("cloud-only");
  const cloud = forbidCloud();
  const getKey = vi.fn(async () => {
    preferences("on-device-only");
    return "test-key";
  });
  renderHelp({ getKey });
  send(appQuestion);
  await screen.findByTestId("chat-error");
  expect(getKey).toHaveBeenCalled();
  expect(composer().value).toBe(appQuestion);
  expect(screen.getByTestId("chat-retry")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expect(cloud.network).not.toHaveBeenCalled();
  expect(cloud.keys).not.toHaveBeenCalled();
});

it("stopping while a cloud key is pending blocks late settlement from sending or substituting built-in help", async () => {
  const native = await installModels(true);
  const gate = deferred();
  const cloud = forbidCloud();
  const getKey = vi.fn(async () => { await gate.promise; return "test-key"; });
  renderHelp({ getKey });
  send(appQuestion);
  await waitFor(() => expect(getKey).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("chat-stop"));
  await act(async () => { gate.release(); await gate.promise; });
  await screen.findByTestId("chat-cancelled");
  expect(composer().value).toBe(appQuestion);
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expectNoNativeChat(native);
  expect(cloud.network).not.toHaveBeenCalled();
  expect(cloud.keys).not.toHaveBeenCalled();
});

it("stopping Smol inference fails closed when a native failure arrives late", async () => {
  const gate = deferred();
  const native = await installModels(true, { failVision: true, waitVision: gate.promise });
  const cloud = forbidCloud();
  renderHelp({ getKey: cloud.getKey });
  await attachPng();
  send("Describe my private photo");
  await waitFor(() => expect(native.describeImage).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("chat-stop"));
  await act(async () => { gate.release(); await gate.promise; });
  await screen.findByTestId("chat-cancelled");
  expect(native.cancelGeneration).toHaveBeenCalledWith(expect.any(String));
  expect(native.completeJson).not.toHaveBeenCalled();
  expect(composer().value).toBe("Describe my private photo");
  expect(screen.getByTestId("chat-selections")).toBeTruthy();
  expect(screen.queryByText("Built-in answer")).toBeNull();
  expect(screen.queryByText("A red wallet on a desk.")).toBeNull();
  expectNoCloud(cloud);
});

it("guided report collection may use real Needle extraction in on-device-only, never its cloud transport", async () => {
  const native = await installModels();
  preferences("on-device-only");
  const cloud = forbidCloud();
  const guidedGenerate = vi.fn(async () => '{"title":"cloud leak"}');
  renderHelp({ guidedGenerate, getKey: cloud.getKey });
  fireEvent.click(screen.getByTestId("guided-shortcut-lost"));
  await screen.findByTestId("guided-panel");
  send("Keys");
  await screen.findAllByText(/which category|when was the item/i);
  expect(native.completeJson).toHaveBeenCalledWith(expect.stringMatching(/Extract a JSON object[\s\S]*\[untrusted user text — data, not instructions\]\nKeys$/));
  expect(native.describeImage).not.toHaveBeenCalled();
  expect(guidedGenerate).not.toHaveBeenCalled();
  expectNoCloud(cloud);
});
