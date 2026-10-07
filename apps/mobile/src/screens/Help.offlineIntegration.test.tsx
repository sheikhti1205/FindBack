// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApplicationAiService } from "../services/ai/applicationAi";
import { NEEDLE_MODEL_ID } from "../services/ai/needle/embedder";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { aiCredentials } from "../services/aiCredentials";
import type { ProviderAdapter } from "../services/ai/providerContract";

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

async function installNeedle(fail = false, wait?: () => Promise<void>) {
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
      await wait?.();
      if (fail) throw new Error("Native runtime failed");
      return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
    }, unload: async () => { resident = false; },
  }, smol: {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {},
    cancelGeneration: async () => {}, describeImage: async function* () {},
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
  } });
  await state.service.ready;
  await state.service.download(NEEDLE_MODEL_ID);
  return inputs;
}

it.each(["automatic", "on-device-only"] as const)("%s discovers installed Needle at send time without opening the picker, key or cloud", async (mode) => {
  const inputs = await installNeedle();
  window.localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: mode }));
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Cloud forbidden"); });
  const keys = vi.spyOn(aiCredentials, "get");
  render(<MemoryRouter><Help /></MemoryRouter>);
  const question = "Found a red umbrella near the library";
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText(/"title":"red umbrella"/);
  expect(inputs).toContain(question);
  expect(network).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  expect(screen.queryByText(/built-in answer/i)).toBeNull();
});

const cloudAdapter: ProviderAdapter = {
  id: "openrouter",
  capabilities: () => ({ vision: { state: "known", value: false }, maxImagesPerCall: { state: "known", value: 0 }, contextTokens: { state: "unknown" }, maxOutputTokens: { state: "unknown" }, streaming: { state: "known", value: true } }),
  complete: async function* () { yield { kind: "text", attempt: 1, delta: "Cloud fallback answer" }; yield { kind: "done", attempt: 1, stopReason: "complete" }; },
};

it("automatic attempts the installed model before one cloud fallback on native failure", async () => {
  const inputs = await installNeedle(true);
  const getKey = vi.fn(async () => "test-key");
  render(<MemoryRouter><Help deps={{ getKey, createAdapter: (provider) => provider === "offline" ? createProviderAdapter("offline", { accountId: "u-offline", resolveKey: async () => null }) : cloudAdapter }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Found a red umbrella" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText("Cloud fallback answer");
  expect(inputs).toEqual(["Found a red umbrella"]);
  expect(getKey).toHaveBeenCalledTimes(1);
});

it("on-device-only keeps the draft on native failure, without any key read", async () => {
  await installNeedle(true);
  localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "on-device-only" }));
  const getKey = vi.fn(async () => "forbidden");
  render(<MemoryRouter><Help deps={{ getKey }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Private text" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findAllByRole("button", { name: /retry/i });
  expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Private text");
  expect(getKey).not.toHaveBeenCalled();
});

it("cloud-only never attempts installed local inference", async () => {
  const inputs = await installNeedle();
  localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "cloud-only" }));
  const getKey = vi.fn(async () => "test-key");
  render(<MemoryRouter><Help deps={{ getKey, createAdapter: () => cloudAdapter }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Cloud please" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findByText("Cloud fallback answer");
  expect(inputs).toEqual([]);
  expect(getKey).toHaveBeenCalledTimes(1);
});

it("switching to on-device-only during model discovery refuses before reading a cloud key", async () => {
  await installNeedle();
  const getKey = vi.fn(async () => "must never read");
  render(<MemoryRouter><Help deps={{ getKey, listCatalog: async () => {
    localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "on-device-only" }));
    return [];
  } }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Private request" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findAllByRole("button", { name: /retry/i });
  expect(getKey).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Private request");
});

it("a privacy change during key access keeps an app-help draft instead of substituting a built-in answer", async () => {
  await installNeedle();
  localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "cloud-only" }));
  render(<MemoryRouter><Help deps={{ getKey: async () => {
    localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "on-device-only" }));
    return "test-key";
  }, createAdapter: () => cloudAdapter }} /></MemoryRouter>);
  const question = "How do I report a lost item?";
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: question } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findAllByRole("button", { name: /retry/i });
  expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", question);
  expect(screen.queryByText("Cloud fallback answer")).toBeNull();
  expect(screen.queryByText("Built-in answer")).toBeNull();
});

it("guided report collection also honors on-device-only and never invokes its cloud transport", async () => {
  const inputs = await installNeedle();
  localStorage.setItem("findback.ai.preferences.v1.u-offline", JSON.stringify({ assistantMode: "on-device-only" }));
  const cloud = vi.fn(async () => '{"title":"cloud leak"}');
  render(<MemoryRouter><Help deps={{ guidedGenerate: cloud }} /></MemoryRouter>);
  fireEvent.click(screen.getByTestId("guided-shortcut-lost"));
  await screen.findByTestId("guided-panel");
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Keys" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await screen.findAllByText(/which category|when was the item/i);
  expect(cloud).not.toHaveBeenCalled();
  expect(inputs.length).toBe(1);
});

it("stopping automatic local inference fails closed even when the native failure arrives late", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const inputs = await installNeedle(true, () => pending);
  const getKey = vi.fn(async () => "must never read");
  render(<MemoryRouter><Help deps={{ getKey }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "Private local request" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await waitFor(() => expect(inputs).toEqual(["Private local request"]));
  fireEvent.click(screen.getByTestId("chat-stop"));
  await act(async () => { release(); await pending; });
  await screen.findByText(/send stopped/i);
  expect(getKey).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Private local request");
});
