// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateAiPreferences } from "./ai/aiPreferences";
import { liveGenerateFor } from "./liveNarrowTasks";

const state = vi.hoisted(() => ({ account: "transport-a" as string | null, route: vi.fn(), keys: vi.fn(), onSession: undefined as (() => void) | undefined }));
vi.mock("./ai/applicationAi", () => ({ getApplicationAi: () => ({ route: state.route }) }));
vi.mock("./aiCredentials", () => ({ aiCredentials: { get: state.keys } }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => { state.onSession?.(); return { data: { session: state.account ? { user: { id: state.account } } : null }, error: null }; } } }) }));

beforeEach(() => {
  localStorage.clear(); state.account = "transport-a";
  state.onSession = undefined;
  state.route.mockReset().mockResolvedValue({ ok: false, state: "FAILED", error: "MODEL_NOT_READY" });
  state.keys.mockReset().mockResolvedValue("fake-test-credential");
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("automatic local failure produces the real free-only OpenRouter HTTP request with the owning account key", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"category":"keys"}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const answer = await liveGenerateFor("classify-category")("Classify these keys", { maxOutputTokens: 8, temperature: 0 });
  expect(answer).toBe('{"category":"keys"}');
  expect(state.route).toHaveBeenCalledTimes(1);
  expect(state.keys).toHaveBeenCalledWith("transport-a", "openrouter");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(JSON.parse(requests[0]?.init?.body as string)).toMatchObject({ model: "openrouter/free", stream: false, messages: [{ role: "user", content: "Classify these keys" }] });
});

it.each(["on-device-only", "automatic"] as const)("%s cancellation never reaches real HTTP or reads a key", async (mode) => {
  updateAiPreferences("transport-a", { assistantMode: mode });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  state.route.mockImplementation(async () => { abort.abort(); throw new Error("native stopped"); });
  await expect(liveGenerateFor("extract-report-fields")("private text", { maxOutputTokens: 8, temperature: 0, signal: abort.signal } as never)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled(); expect(state.keys).not.toHaveBeenCalled();
});

it("a session switch while unlocking the key cannot send an HTTP request", async () => {
  updateAiPreferences("transport-a", { assistantMode: "cloud-only" });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  state.keys.mockImplementation(async () => { state.account = "transport-b"; return "old-account-key"; });
  await expect(liveGenerateFor("extract-search-filters")("private", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow(/account changed/i);
  expect(fetch).not.toHaveBeenCalled(); expect(state.route).not.toHaveBeenCalled();
});

it("on-device-only native failure never reads a key or calls real HTTP", async () => {
  updateAiPreferences("transport-a", { assistantMode: "on-device-only" });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(liveGenerateFor("classify-category")("private", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow("MODEL_NOT_READY");
  expect(fetch).not.toHaveBeenCalled(); expect(state.keys).not.toHaveBeenCalled();
});

it("changing to on-device-only during session resolution refuses before the vault read", async () => {
  updateAiPreferences("transport-a", { assistantMode: "cloud-only" });
  let sessions = 0;
  state.onSession = () => { if (++sessions === 3) updateAiPreferences("transport-a", { assistantMode: "on-device-only" }); };
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(liveGenerateFor("classify-category")("private", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow(/cloud is disabled/i);
  expect(state.keys).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
