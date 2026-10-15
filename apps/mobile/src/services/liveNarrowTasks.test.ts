// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  route: vi.fn(),
  text: vi.fn(),
  account: "account-a" as string | null,
  keyReads: vi.fn(),
}));

vi.mock("./ai/applicationAi", () => ({
  getApplicationAi: () => ({ route: state.route }),
}));

vi.mock("./openRouter", () => ({
  createOpenRouterClient: (getKey: () => Promise<string | null>) => ({ text: async (...args: unknown[]) => { await getKey(); return state.text(...args); } }),
}));

vi.mock("./aiCredentials", () => ({
  getConnectedOpenRouterKey: async () => "test-key",
  aiCredentials: { get: state.keyReads },
}));
vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: state.account ? { user: { id: state.account } } : null } }) } }),
}));
import { updateAiPreferences } from "./ai/aiPreferences";

import {
  generateCloud,
  generateForCategoryLive,
  generateForFieldsLive,
  generateLocalFirst,
  liveGenerateFor,
  nlExtractLive,
} from "./liveNarrowTasks";

function okRoute(value: unknown) {
  return {
    ok: true as const,
    value,
    provenance: {} as never,
    state: "COMPLETE" as const,
  };
}

function failRoute(error: string) {
  return {
    ok: false as const,
    error,
    denialReason: "RUNTIME_ERROR",
    provenance: {} as never,
    state: "FAILED" as const,
  };
}

function abortErr(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

beforeEach(() => {
  state.route.mockReset();
  state.text.mockReset();
  state.keyReads.mockReset().mockResolvedValue("test-key");
  state.account = "account-a";
  localStorage.clear();
});

describe("narrow tasks are strictly on-device", () => {
  it.each(["extract-report-fields", "classify-category", "extract-search-filters"] as const)(
    "%s surfaces a local failure instead of escalating to the network",
    async (task) => {
      state.route.mockResolvedValue(failRoute("MODEL_NOT_READY"));
      state.text.mockResolvedValue("must not send");
      await expect(liveGenerateFor(task)("private", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow("MODEL_NOT_READY");
      expect(state.keyReads).not.toHaveBeenCalled();
      expect(state.text).not.toHaveBeenCalled();
    },
  );

  it.each(["automatic", "cloud-only", "on-device-only"] as const)(
    "the %s assistant preference does not reintroduce a cloud fallback",
    async (assistantMode) => {
      updateAiPreferences("account-a", { assistantMode });
      state.route.mockResolvedValue(failRoute("RUNTIME_ERROR"));
      state.text.mockResolvedValue("must not send");
      await expect(generateForCategoryLive("p", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow("RUNTIME_ERROR");
      expect(state.keyReads).not.toHaveBeenCalled();
      expect(state.text).not.toHaveBeenCalled();
    },
  );

  it("returns a successful local result without ever reading a cloud key", async () => {
    state.route.mockResolvedValue(okRoute("local"));
    await expect(generateForCategoryLive("p", { maxOutputTokens: 8, temperature: 0 })).resolves.toBe("local");
    expect(state.keyReads).not.toHaveBeenCalled();
  });

  it("structured cancellation is never a network event", async () => {
    state.route.mockResolvedValue({ ...failRoute("cancelled"), state: "CANCELLED" });
    await expect(generateForFieldsLive("p", { maxOutputTokens: 8, temperature: 0 })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.text).not.toHaveBeenCalled();
  });

  it("a local failure after an account switch still cannot reach the network", async () => {
    state.route.mockImplementation(async () => { state.account = "account-b"; return failRoute("runtime failed"); });
    await expect(generateForFieldsLive("p", { maxOutputTokens: 8, temperature: 0 })).rejects.toThrow("runtime failed");
    expect(state.keyReads).not.toHaveBeenCalled();
    expect(state.text).not.toHaveBeenCalled();
  });
});

describe("generateLocalFirst", () => {
  it("routes {prompt} with traceId + consent and returns string values as-is", async () => {
    state.route.mockResolvedValue(okRoute('{"query":"wallet"}'));
    const out = await generateLocalFirst("extract-search-filters", "hello");
    expect(out).toBe('{"query":"wallet"}');
    expect(state.route).toHaveBeenCalledTimes(1);
    expect(state.route.mock.calls[0]![0]).toBe("extract-search-filters");
    expect(state.route.mock.calls[0]![1]).toEqual({ prompt: "hello" });
    const ctx = state.route.mock.calls[0]![2] as Record<string, unknown>;
    expect(typeof ctx["traceId"]).toBe("string");
    expect(ctx["consent"]).toBe(true);
  });

  it("JSON-stringifies non-string route values", async () => {
    state.route.mockResolvedValue(okRoute({ fields: { query: "wallet" } }));
    await expect(generateLocalFirst("extract-report-fields", "p")).resolves.toBe(
      JSON.stringify({ fields: { query: "wallet" } }),
    );
  });

  it("throws Error(result.error) when the route is not ok", async () => {
    state.route.mockResolvedValue(failRoute("MODEL_NOT_READY"));
    await expect(generateLocalFirst("classify-category", "p")).rejects.toThrow("MODEL_NOT_READY");
  });

  it("propagates AbortError without wrapping", async () => {
    state.route.mockRejectedValue(abortErr());
    const caught = await generateLocalFirst("extract-search-filters", "p").catch((e: unknown) => e);
    expect((caught as Error).name).toBe("AbortError");
  });

  it("throws AbortError before routing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateLocalFirst("extract-search-filters", "p", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.route).not.toHaveBeenCalled();
  });

  it("routes localInput instead of the engineered prompt when supplied", async () => {
    state.route.mockResolvedValue(okRoute('{"query":"wallet"}'));
    await generateLocalFirst("extract-report-fields", "Extract report slots. Return ONLY one JSON object.", {
      localInput: { text: "a red umbrella" },
    });
    expect(state.route.mock.calls[0]![1]).toEqual({ text: "a red umbrella" });
  });
});

describe("local task input (Phase A.4)", () => {
  it("routes localTaskInput to the on-device engine and returns its value", async () => {
    state.route.mockResolvedValue(okRoute('{"category":"electronics"}'));
    const out = await liveGenerateFor("classify-category")(
      "Classify the item text. Return ONLY one JSON object.",
      { maxOutputTokens: 8, temperature: 0, localTaskInput: { text: "red umbrella" } },
    );
    expect(out).toBe('{"category":"electronics"}');
    expect(state.route.mock.calls[0]![1]).toEqual({ text: "red umbrella" });
    expect(state.text).not.toHaveBeenCalled();
  });

  it("the engineered prompt is never sent to a network transport on local failure", async () => {
    state.route.mockResolvedValue(failRoute("RUNTIME_ERROR"));
    state.text.mockResolvedValue('{"category":"electronics"}');
    await expect(
      liveGenerateFor("classify-category")("Engineered prompt here.", {
        maxOutputTokens: 8,
        temperature: 0,
        localTaskInput: { text: "red umbrella" },
      }),
    ).rejects.toThrow("RUNTIME_ERROR");
    expect(state.text).not.toHaveBeenCalled();
  });
});

describe("liveGenerateFor (on-device only)", () => {
  it("uses the local result and never touches the network", async () => {
    state.route.mockResolvedValue(okRoute('{"category":"electronics"}'));
    const out = await liveGenerateFor("classify-category")("prompt", {
      maxOutputTokens: 8,
      temperature: 0,
    });
    expect(out).toBe('{"category":"electronics"}');
    expect(state.text).not.toHaveBeenCalled();
  });

  it("rejects on non-abort local failure instead of falling back to cloud", async () => {
    state.route.mockResolvedValue(failRoute("RUNTIME_ERROR"));
    state.text.mockResolvedValue('{"category":"electronics"}');
    await expect(
      liveGenerateFor("classify-category")("prompt", { maxOutputTokens: 8, temperature: 0 }),
    ).rejects.toThrow("RUNTIME_ERROR");
    expect(state.text).not.toHaveBeenCalled();
    expect(state.keyReads).not.toHaveBeenCalled();
  });

  it("an abort never touches the network", async () => {
    state.route.mockRejectedValue(abortErr());
    const gen = liveGenerateFor("extract-report-fields");
    await expect(
      gen("prompt", { maxOutputTokens: 8, temperature: 0 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.text).not.toHaveBeenCalled();
  });

  it("a pre-aborted signal never touches local or network", async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = liveGenerateFor("extract-report-fields");
    await expect(
      gen("prompt", { maxOutputTokens: 8, temperature: 0, signal: controller.signal } as never),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(state.route).not.toHaveBeenCalled();
    expect(state.text).not.toHaveBeenCalled();
  });
});

describe("generateCloud", () => {
  it("sends the prompt through the OpenRouter text transport", async () => {
    state.text.mockResolvedValue("cloud answer");
    await expect(
      generateCloud("hello", { maxOutputTokens: 8, temperature: 0 }),
    ).resolves.toBe("cloud answer");
    expect(state.text).toHaveBeenCalledWith("hello", { signal: undefined });
  });
});

describe("ready-made live composers", () => {
  it("generateForFieldsLive / generateForCategoryLive match the GenerateFn shape", async () => {
    state.route.mockResolvedValue(okRoute("{}"));
    await expect(
      generateForFieldsLive("t", { maxOutputTokens: 8, temperature: 0 }),
    ).resolves.toBe("{}");
    await expect(
      generateForCategoryLive("t", { maxOutputTokens: 8, temperature: 0 }),
    ).resolves.toBe("{}");
    expect(state.route.mock.calls[0]![0]).toBe("extract-report-fields");
    expect(state.route.mock.calls[1]![0]).toBe("classify-category");
  });

  it("nlExtractLive never calls generate for empty input", async () => {
    await expect(nlExtractLive("   ")).resolves.toEqual({});
    expect(state.route).not.toHaveBeenCalled();
    expect(state.text).not.toHaveBeenCalled();
  });

  it("nlExtractLive returns a validated patch through the live transport", async () => {
    // Local route yields search slot JSON; validators keep only confident filters.
    state.route.mockResolvedValue(
      okRoute(JSON.stringify({ query: "black wallet", dateRangeText: "last week" })),
    );
    const patch = await nlExtractLive("black wallet lost last week");
    expect(patch.query).toBe("black wallet");
    expect(patch.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(patch.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("nlExtractLive fails closed to an empty patch when the on-device route fails", async () => {
    state.route.mockResolvedValue(failRoute("RUNTIME_ERROR"));
    state.text.mockRejectedValue(new Error("no key"));
    await expect(nlExtractLive("black wallet")).resolves.toEqual({});
    expect(state.text).not.toHaveBeenCalled();
  });
});
