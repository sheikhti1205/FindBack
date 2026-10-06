import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groundReportPhoto } from "./livePhotoGrounding";
import { ApplicationAiService, DOWNLOAD_MODELS } from "./ai/applicationAi";
import type { ModelDownloadDriver } from "./ai/download/driver";
import type { OfflineVisionNativeBridge } from "./ai/providers/offline";
import { aiPreferencesKey } from "./ai/aiPreferences";

const { application, normalized } = vi.hoisted(() => ({ application: { current: undefined as unknown }, normalized: vi.fn() }));
vi.mock("./image", () => ({ normalizeImage: normalized }));
vi.mock("./ai/applicationAi", async (original) => ({
  ...await original<typeof import("./ai/applicationAi")>(), getApplicationAi: () => application.current,
}));
// Credentials are a test boundary only; the real image HTTP client is exercised.
vi.mock("./aiCredentials", () => ({
  getConnectedOpenRouterKey: async () => "test-only-placeholder",
  aiCredentials: { get: async () => "test-only-placeholder" },
}));
const { sessionUser } = vi.hoisted(() => ({ sessionUser: { current: null as string | null } }));
vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: sessionUser.current ? { user: { id: sessionUser.current } } : null }, error: null }) } }),
}));
const raw = JSON.stringify({ coordinateSpace: "relative-0-1000", boxes: [{ x: 100, y: 200, w: 300, h: 400, label: "red backpack" }] });
const file = new File(["original"], "photo.jpg", { type: "image/jpeg" });
const data = "data:image/jpeg;base64,cGhvdG8=";
const encoded = { blob: new Blob(["photo"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 100, height: 200 };
beforeEach(() => { normalized.mockReset(); normalized.mockResolvedValue(encoded); sessionUser.current = null; vi.unstubAllGlobals(); });
afterEach(() => vi.unstubAllGlobals());

function deps(localText: string | null = raw) {
  const local = vi.fn(async () => localText);
  const cloud = vi.fn(async () => raw);
  return { local, cloud };
}
describe("live photo grounding transport", () => {
  it("requires consent and valid input before normalization or any inference", async () => {
    const d = deps();
    await expect(groundReportPhoto(file, "backpack", false, { deps: d })).rejects.toThrow(/Confirm/);
    await expect(groundReportPhoto(file, " ", true, { deps: d })).rejects.toThrow(/describe/i);
    await expect(groundReportPhoto(file, "x".repeat(141), true, { deps: d })).rejects.toThrow(/140/);
    await expect(groundReportPhoto(new File(["x"], "x.gif", { type: "image/gif" }), "bag", true, { deps: d })).rejects.toThrow(/JPEG/);
    expect(normalized).not.toHaveBeenCalled(); expect(d.local).not.toHaveBeenCalled(); expect(d.cloud).not.toHaveBeenCalled();
  });
  it("binds normalized photo bytes to local-first ground-objects generation and returns only validated selectors", async () => {
    const d = deps(); const signal = new AbortController().signal;
    const result = await groundReportPhoto(file, "the backpack", true, { deps: d, signal, photoEngine: "automatic", accountId: "owner" });
    expect(result).toMatchObject({ ok: true, value: { engine: "on-device", imageUrl: data, options: [{ label: "red backpack" }] } });
    expect(d.local).toHaveBeenCalledWith(expect.stringContaining("Referring expression: the backpack"), "cGhvdG8=", expect.objectContaining({ signal: expect.any(AbortSignal), accountId: "owner" }));
    expect(d.cloud).not.toHaveBeenCalled();
    expect(normalized).toHaveBeenCalledWith(file, undefined, { signal });
  });
  it("on-device-only never contacts cloud on absence or invalid local boxes", async () => {
    for (const output of [null, '{"coordinateSpace":"relative-0-1000","boxes":[{"x":900,"y":0,"w":200,"h":20,"label":"bag"}]}']) {
      const d = deps(output);
      const result = await groundReportPhoto(file, "bag", true, { deps: d, photoEngine: "on-device-only" });
      expect(result.ok).toBe(false); expect(d.cloud).not.toHaveBeenCalled();
    }
  });
  it("cloud-only skips local and attaches actual image with consent and signal", async () => {
    const d = deps(); const signal = new AbortController().signal;
    const result = await groundReportPhoto(file, "bag", true, { deps: d, signal, photoEngine: "cloud-only" });
    expect(result).toMatchObject({ ok: true, value: { engine: "cloud" } });
    expect(d.local).not.toHaveBeenCalled();
    expect(d.cloud).toHaveBeenCalledWith(expect.stringContaining("Ground the referring expression"), data, true, { signal: expect.any(AbortSignal) });
  });
  it("automatic falls back on local absence or invalid output, but not an empty validated match set", async () => {
    for (const output of [null, "not JSON"]) {
      const d = deps(output);
      expect(await groundReportPhoto(file, "bag", true, { deps: d, photoEngine: "automatic" })).toMatchObject({ ok: true, value: { engine: "cloud" } });
      expect(d.cloud).toHaveBeenCalledTimes(1);
    }
    const d = deps('{"coordinateSpace":"relative-0-1000","boxes":[]}');
    expect(await groundReportPhoto(file, "bag", true, { deps: d })).toMatchObject({ ok: true, value: { options: [] } });
    expect(d.cloud).not.toHaveBeenCalled();
  });
  it("never falls back after local abort, including abort before start and late noncooperative output", async () => {
    const pre = new AbortController(); pre.abort(); const d = deps();
    await expect(groundReportPhoto(file, "bag", true, { deps: d, signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(d.local).not.toHaveBeenCalled(); expect(d.cloud).not.toHaveBeenCalled();
    const controller = new AbortController();
    d.local.mockImplementation(async () => { controller.abort(); return raw; });
    await expect(groundReportPhoto(file, "bag", true, { deps: d, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(d.cloud).not.toHaveBeenCalled();
    const throwing = deps(); throwing.local.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(groundReportPhoto(file, "bag", true, { deps: throwing })).rejects.toMatchObject({ name: "AbortError" });
    expect(throwing.cloud).not.toHaveBeenCalled();
  });
  it("rejects normalized image bounds and invalid cloud boxes", async () => {
    const d = deps(); normalized.mockResolvedValueOnce({ ...encoded, width: 1921 });
    await expect(groundReportPhoto(file, "bag", true, { deps: d })).rejects.toThrow(/JPEG/);
    expect(d.local).not.toHaveBeenCalled(); expect(d.cloud).not.toHaveBeenCalled();
    d.cloud.mockResolvedValue('{"coordinateSpace":"pixels","boxes":[]}');
    const result = await groundReportPhoto(file, "bag", true, { deps: d, photoEngine: "cloud-only" });
    expect(result.ok).toBe(false);
  });
  it("uses the real OpenRouter image HTTP client by default, with image_url content", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: "stop" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await groundReportPhoto(file, "bag", true, { photoEngine: "cloud-only" })).toMatchObject({ ok: true, value: { engine: "cloud" } });
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("openrouter/free");
    expect(body.messages[0].content).toContainEqual({ type: "image_url", image_url: { url: data } });
  });
  it("reads the owning account's photo engine rather than an unrelated global override", async () => {
    const d = deps(null);
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === aiPreferencesKey("owner") ? JSON.stringify({ photoEngine: "on-device-only" }) : null });
    vi.stubGlobal("__findbackPhotoEngine", "cloud-only");
    expect((await groundReportPhoto(file, "bag", true, { accountId: "owner", deps: d })).ok).toBe(false);
    expect(d.local).toHaveBeenCalledTimes(1); expect(d.cloud).not.toHaveBeenCalled();
  });
  it("never retargets a cloud send to an account the session does not own", async () => {
    sessionUser.current = "session-owner";
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(groundReportPhoto(file, "bag", true, { photoEngine: "cloud-only", accountId: "someone-else" }))
      .rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates abort into the real cloud HTTP request and returns no usable selectors", async () => {
    let entered!: () => void; let httpSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      httpSignal = init?.signal ?? undefined; entered();
      return new Promise((_, reject) => httpSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = groundReportPhoto(file, "bag", true, { photoEngine: "cloud-only", signal: controller.signal });
    await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(httpSignal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// Real application owner + offline provider + vision bridge, with only disk and
// native inference replaced. This proves production closure binding/cancel, not
// just an injected GenerateFn returning JSON without a photo.
async function platform(stall = false) {
  const disk = new Map<string, string>();
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/test-models", freeBytes: async () => 2_000_000_000,
    stagedSize: async () => 0, readJournalText: async () => null,
    download: async (a) => { disk.set(a.stagingPath, a.expectedSha256); return { receivedBytes: a.maxBytes, totalBytes: a.maxBytes, actualHex: a.expectedSha256, finalUrl: a.url }; },
    cancelDownload: async () => {}, hashFile: async (path) => disk.get(path) ?? "",
    promoteFile: async (a, b) => { disk.set(b, disk.get(a)!); }, removeFile: async (path) => { disk.delete(path); },
  };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let seen: { request: unknown; signal: AbortSignal } | undefined;
  const smol: OfflineVisionNativeBridge = {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => true,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {},
    describeImage: async function* (request, signal) {
      seen = { request, signal }; entered();
      if (stall) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (!signal.aborted) yield { textDelta: raw };
    },
  };
  const needle = { bridgeName: "needle-cact" as const, isNeedleAvailable: async () => false, embeddingDimension: async () => 2,
    loadModel: async () => 2, embedNeedleTexts: async () => [], initTools: async () => {}, completeJson: async () => "", unload: async () => {} };
  const service = new ApplicationAiService({ android: true, driver, smol, needle });
  await service.ready; await service.download(DOWNLOAD_MODELS[1].modelId); application.current = service;
  return { started, seen: () => seen };
}
it("default local production adapter receives actual photo bytes and ground-objects instruction", async () => {
  const p = await platform();
  expect(await groundReportPhoto(file, "the backpack", true, { photoEngine: "on-device-only", accountId: "owner" })).toMatchObject({ ok: true, value: { engine: "on-device" } });
  expect(p.seen()?.request).toMatchObject({ imageBase64: "cGhvdG8=", prompt: expect.stringContaining("Referring expression: the backpack") });
});
it("default local production adapter propagates user abort to native generation and never sends cloud", async () => {
  const p = await platform(true); const controller = new AbortController(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const pending = groundReportPhoto(file, "the backpack", true, { signal: controller.signal });
  await p.started; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(p.seen()?.signal.aborted).toBe(true); expect(fetcher).not.toHaveBeenCalled();
});
