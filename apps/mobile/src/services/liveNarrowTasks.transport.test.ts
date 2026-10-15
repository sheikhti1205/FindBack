// @vitest-environment jsdom
//
// Boundary proof for the narrow-task transport: report-field/category
// suggestions and Smart Search filter extraction must never produce a network
// request and must never read a stored provider credential — under every
// assistant preference, across `ok:false` and thrown route failures, and for a
// cancel that races a local failure. Also pins the legacy cloud transport's
// account-scoped guard, which the guided Help assistant still depends on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateAiPreferences } from "./ai/aiPreferences";
import { generateCloudForAccount, liveGenerateFor } from "./liveNarrowTasks";

const state = vi.hoisted(() => ({
  account: "transport-a" as string | null,
  route: vi.fn(),
  keys: vi.fn(),
}));

vi.mock("./ai/applicationAi", () => ({ getApplicationAi: () => ({ route: state.route }) }));
vi.mock("./aiCredentials", () => ({ aiCredentials: { get: state.keys } }));
vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: state.account ? { user: { id: state.account } } : null },
        error: null,
      }),
    },
  }),
}));

beforeEach(() => {
  localStorage.clear();
  state.account = "transport-a";
  state.route.mockReset().mockResolvedValue({ ok: false, state: "FAILED", error: "MODEL_NOT_READY" });
  state.keys.mockReset().mockResolvedValue("fake-test-credential");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("a local failure never produces an HTTP request or reads a stored credential", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    liveGenerateFor("classify-category")("Classify these keys", { maxOutputTokens: 8, temperature: 0 }),
  ).rejects.toThrow("MODEL_NOT_READY");
  expect(state.route).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(state.keys).not.toHaveBeenCalled();
});

it.each(["automatic", "cloud-only", "on-device-only"] as const)(
  "the %s preference cannot route a narrow task to the network",
  async (mode) => {
    updateAiPreferences("transport-a", { assistantMode: mode });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    state.keys.mockImplementation(async () => {
      throw new Error("a credential must never be read for a narrow task");
    });
    await expect(
      liveGenerateFor("extract-report-fields")("private text", { maxOutputTokens: 8, temperature: 0 }),
    ).rejects.toThrow("MODEL_NOT_READY");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.keys).not.toHaveBeenCalled();
  },
);

it.each(["on-device-only", "automatic", "cloud-only"] as const)("%s cancellation never reaches real HTTP or reads a key", async (mode) => {
  updateAiPreferences("transport-a", { assistantMode: mode });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  state.route.mockImplementation(async () => {
    abort.abort();
    throw new Error("native stopped");
  });
  await expect(
    liveGenerateFor("extract-report-fields")("private text", {
      maxOutputTokens: 8,
      temperature: 0,
      signal: abort.signal,
    } as never),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect(state.keys).not.toHaveBeenCalled();
});

it("a session switch during a local failure cannot send an HTTP request", async () => {
  updateAiPreferences("transport-a", { assistantMode: "cloud-only" });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  state.route.mockImplementation(async () => {
    state.account = "transport-b";
    return { ok: false, state: "FAILED", error: "RUNTIME_ERROR" };
  });
  await expect(
    liveGenerateFor("extract-search-filters")("private", { maxOutputTokens: 8, temperature: 0 }),
  ).rejects.toThrow("RUNTIME_ERROR");
  expect(fetch).not.toHaveBeenCalled();
  expect(state.keys).not.toHaveBeenCalled();
});

it("a successful local result is returned without a credential read", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  state.route.mockResolvedValue({
    ok: true,
    value: '{"category":"keys"}',
    provenance: {},
    state: "COMPLETE",
  });
  await expect(
    liveGenerateFor("classify-category")("Classify these keys", { maxOutputTokens: 8, temperature: 0 }),
  ).resolves.toBe('{"category":"keys"}');
  expect(fetch).not.toHaveBeenCalled();
  expect(state.keys).not.toHaveBeenCalled();
});

it("a route rejection with no signal propagates without real HTTP or a credential read", async () => {
  updateAiPreferences("transport-a", { assistantMode: "cloud-only" });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  state.route.mockImplementation(async () => {
    throw new Error("native engine exploded");
  });
  await expect(
    liveGenerateFor("extract-search-filters")("private text", { maxOutputTokens: 8, temperature: 0 }),
  ).rejects.toThrow("native engine exploded");
  expect(fetch).not.toHaveBeenCalled();
  expect(state.keys).not.toHaveBeenCalled();
});

// The guided Help assistant still uses the legacy cloud transport, so its
// account-scoped guard must stay live and preference-conditional. These run
// against the real OpenRouter client (only `fetch` is stubbed).
describe("legacy cloud transport guard (guided Help assistant)", () => {
  it("refuses before any HTTP or credential read while the account is on-device-only", async () => {
    updateAiPreferences("transport-a", { assistantMode: "on-device-only" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(generateCloudForAccount("transport-a", "guided prompt", undefined)).rejects.toThrow(
      "On-device only: cloud is disabled.",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(state.keys).not.toHaveBeenCalled();
  });

  it("still reaches the network transport when the preference allows cloud", async () => {
    updateAiPreferences("transport-a", { assistantMode: "automatic" });
    const fetch = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetch);
    await expect(generateCloudForAccount("transport-a", "guided prompt", undefined)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.keys).toHaveBeenCalledWith("transport-a", "openrouter");
  });
});
