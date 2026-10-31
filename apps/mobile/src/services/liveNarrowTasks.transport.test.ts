// @vitest-environment jsdom
//
// Boundary proof for the narrow-task transport: report-field/category
// suggestions and Smart Search filter extraction must never produce a network
// request and must never read a stored provider credential. Coverage is per
// cause, and the cause list is what the assertions below enumerate: an `ok:false`
// route under every assistant preference, a THROWN route under every preference,
// a thrown route with no signal, a session switch mid-flight, and a cancel that
// races a local failure. Separate cloud Chat account/key fencing is covered
// by aiCredentials, chatController and account-switch tests, not this boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateAiPreferences } from "./ai/aiPreferences";
import { liveGenerateFor } from "./liveNarrowTasks";
import * as narrowTaskTransport from "./liveNarrowTasks";

it("does not export a network transport from the local tools boundary", () => {
  expect("generateCloud" in narrowTaskTransport).toBe(false);
  expect("generateCloudForAccount" in narrowTaskTransport).toBe(false);
});

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

it.each(["automatic", "cloud-only", "on-device-only"] as const)(
  "a thrown route under the %s preference propagates without real HTTP or a credential read",
  async (mode) => {
    updateAiPreferences("transport-a", { assistantMode: mode });
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
  },
);
