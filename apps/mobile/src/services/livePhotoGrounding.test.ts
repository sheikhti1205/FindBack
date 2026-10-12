import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groundReportPhoto } from "./livePhotoGrounding";
import { ApplicationAiService } from "./ai/applicationAi";
import { SMOL_VISION_DESCRIPTOR } from "./ai/modelDescriptors";
import type { ModelDownloadDriver } from "./ai/download/driver";
import type { OfflineVisionNativeBridge, OfflineVisionRequest } from "./ai/providers/offline";
import { aiPreferencesKey } from "./ai/aiPreferences";

const { application, normalized } = vi.hoisted(() => ({ application: { current: undefined as unknown }, normalized: vi.fn() }));
vi.mock("./image", () => ({ normalizeImage: normalized }));
vi.mock("./ai/applicationAi", async (original) => ({
  ...await original<typeof import("./ai/applicationAi")>(), getApplicationAi: () => application.current,
}));
// Credentials are a test boundary only; the real image HTTP client is exercised.
// resolveAccountOpenRouterKey mirrors the production contract exactly (single
// session lookup, fail closed on absent/mismatched session — pinned for real
// in aiCredentials.test.ts) so transport tests prove no-send on switch; the
// credentialGet spy proves a foreign account's slot is never even read.
const { credentialGet } = vi.hoisted(() => ({ credentialGet: vi.fn(async (_accountId: string, _provider: string) => "test-only-placeholder") }));
vi.mock("./aiCredentials", () => ({
  getConnectedOpenRouterKey: async () => "test-only-placeholder",
  aiCredentials: { get: credentialGet },
  resolveAccountOpenRouterKey: async (accountId: string) => {
    if (accountId === "local") return "test-only-placeholder";
    const current = sessionUser.current;
    if (current === null || current !== accountId) throw new Error("AI account changed or is not authenticated.");
    return credentialGet(accountId, "openrouter");
  },
}));
const { sessionUser } = vi.hoisted(() => ({ sessionUser: { current: null as string | null } }));
vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: sessionUser.current ? { user: { id: sessionUser.current } } : null }, error: null }) } }),
}));
const raw = JSON.stringify({ coordinateSpace: "relative-0-1000", boxes: [{ x: 100, y: 200, w: 300, h: 400, label: "red backpack" }] });
const file = new File(["original"], "photo.jpg", { type: "image/jpeg" });
const data = "data:image/jpeg;base64,cGhvdG8=";
const encoded = { blob: new Blob(["photo"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 100, height: 200 };
beforeEach(() => { normalized.mockReset(); normalized.mockResolvedValue(encoded); credentialGet.mockClear(); sessionUser.current = null; vi.unstubAllGlobals(); });
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
    // Empty sources refuse before normalization; GIF now normalizes first
    // (no MIME pre-gate) and attempts inference.
    await expect(groundReportPhoto(new File([], "empty.jpg", { type: "image/jpeg" }), "bag", true, { deps: d })).rejects.toThrow(/photo/i);
    expect(normalized).not.toHaveBeenCalled(); expect(d.local).not.toHaveBeenCalled(); expect(d.cloud).not.toHaveBeenCalled();
    const gifDeps = deps();
    normalized.mockResolvedValueOnce(encoded);
    await expect(groundReportPhoto(new File(["gif"], "x.gif", { type: "image/gif" }), "bag", true, { deps: gifDeps, photoEngine: "cloud-only" })).resolves.toMatchObject({ ok: true });
    expect(normalized).toHaveBeenCalled();
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
  it("rejects degenerate normalized images but accepts large derivatives (no 1920px skip)", async () => {
    const d = deps(); normalized.mockResolvedValueOnce({ ...encoded, width: 0 });
    await expect(groundReportPhoto(file, "bag", true, { deps: d })).rejects.toThrow(/photo/i);
    expect(d.local).not.toHaveBeenCalled(); expect(d.cloud).not.toHaveBeenCalled();
    // A 1921px derivative now attempts inference instead of refusing.
    const wide = deps();
    normalized.mockResolvedValueOnce({ ...encoded, width: 1921, height: 1280 });
    await expect(groundReportPhoto(file, "bag", true, { deps: wide })).resolves.toMatchObject({ ok: true });
    expect(wide.local).toHaveBeenCalled();
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
  it("reads the owning account's photo engine with per-account isolation (no global slot)", async () => {
    const d = deps(null);
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === aiPreferencesKey("owner") ? JSON.stringify({ photoEngine: "on-device-only" }) : null });
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
  it("fails closed when the session vanishes before the cloud leg (no signed-in fallback)", async () => {
    // No session at all: the resolver must refuse rather than resolve
    // "whoever is currently signed in", and must never read any key slot.
    sessionUser.current = null;
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(groundReportPhoto(file, "bag", true, { photoEngine: "cloud-only", accountId: "account-a" }))
      .rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(credentialGet).not.toHaveBeenCalled();
  });
  it("an account switch between normalization and the cloud leg aborts before any network call", async () => {
    // Session owns the request while the photo normalizes, then switches to
    // account-b before the cloud key resolves: the send must die and
    // account-b's key slot must never be read.
    sessionUser.current = "account-a";
    normalized.mockImplementation(async (_file: File) => {
      sessionUser.current = "account-b";
      return encoded;
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(groundReportPhoto(file, "bag", true, { photoEngine: "cloud-only", accountId: "account-a" }))
      .rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(credentialGet).not.toHaveBeenCalledWith("account-b", expect.anything());
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
  const smol: OfflineVisionNativeBridge & { collectDeviceFacts: () => Promise<Record<string, unknown>> } = {
    bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => true,
    loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {},
    describeImage: async function* (request: OfflineVisionRequest, signal: AbortSignal) {
      seen = { request, signal }; entered();
      if (stall) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (!signal.aborted) yield { textDelta: raw };
    },
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
  };
  const needle = { bridgeName: "needle-cact" as const, isNeedleAvailable: async () => false, embeddingDimension: async () => 2,
    loadModel: async () => 2, embedNeedleTexts: async () => [], initTools: async () => {}, completeJson: async () => "", unload: async () => {} };
  const service = new ApplicationAiService({ android: true, driver, smol, needle });
  await service.ready; await service.download(SMOL_VISION_DESCRIPTOR.modelId); application.current = service;
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

describe("live photo grounding local timeout", () => {
  it("a local run stalled past 30s times out and automatic mode falls back to cloud", async () => {
    vi.useFakeTimers();
    try {
      const d = deps();
      // The on-device generator never settles: only withTimeout's 30s budget
      // can end this leg.
      d.local.mockImplementation(() => new Promise<string | null>(() => {}));
      const pending = groundReportPhoto(file, "bag", true, { deps: d, photoEngine: "automatic" });
      // Microtasks only: we reach the stalled local leg, and nothing has
      // fallen back yet — the cloud leg is time-gated, not instant.
      await vi.advanceTimersByTimeAsync(0);
      expect(d.local).toHaveBeenCalledTimes(1);
      expect(d.cloud).not.toHaveBeenCalled();
      // Cross the 30s budget: the timeout rejects the local leg and the
      // automatic engine runs the consented cloud fallback.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toMatchObject({ ok: true, value: { engine: "cloud" } });
      expect(d.cloud).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
