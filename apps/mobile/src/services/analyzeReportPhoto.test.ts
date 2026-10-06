import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeReportPhoto } from "./analyzeReportPhoto";

// Session + credential boundary for the real-send account-binding tests.
// resolveAccountOpenRouterKey mirrors the production contract exactly
// (single session lookup, fail closed — pinned for real in
// aiCredentials.test.ts); the credentialGet spy proves a foreign account's
// slot is never even read on a switch.
const { analyzeSession, analyzeCredentialGet } = vi.hoisted(() => ({
  analyzeSession: { current: null as string | null, throws: false },
  analyzeCredentialGet: vi.fn(async (_accountId: string, _provider: string) => "test-only-placeholder"),
}));
vi.mock("./supabaseClient", () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => {
        if (analyzeSession.throws) throw new Error("session read failed");
        return {
          data: { session: analyzeSession.current ? { user: { id: analyzeSession.current } } : null },
          error: null,
        };
      },
    },
  }),
}));
vi.mock("./aiCredentials", () => ({
  getConnectedOpenRouterKey: async () => "test-only-placeholder",
  aiCredentials: { get: analyzeCredentialGet },
  resolveAccountOpenRouterKey: async (accountId: string) => {
    if (accountId === "local") return "test-only-placeholder";
    const current = analyzeSession.current;
    if (current === null || current !== accountId) throw new Error("AI account changed or is not authenticated.");
    return analyzeCredentialGet(accountId, "openrouter");
  },
}));

beforeEach(() => {
  analyzeSession.current = null;
  analyzeSession.throws = false;
  analyzeCredentialGet.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const result = {
  objectName: "umbrella", suggestedCategory: null, colors: ["black"], visibleBrand: null,
  visibleText: [], identifyingFeatures: ["wooden handle"], suggestedTitle: "Black umbrella",
  suggestedDescription: "A black umbrella with a wooden handle.", uncertainFields: [],
};

/** Cloud deps always opt out of the real on-device analyzer unless a test overrides it. */
const cloudOnly = () => ({ analyzeLocally: async () => null as null });

describe("OpenRouter photo suggestions", () => {
  it("requires explicit image-sharing consent before reading the image or calling AI", async () => {
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const send = vi.fn(async () => JSON.stringify(result));
    const analyzeLocally = vi.fn(async () => null);
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, false, { deps: { encode, send, analyzeLocally } })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(encode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(analyzeLocally).not.toHaveBeenCalled();
  });

  it("returns validated suggestions for user review, without mutating report fields", async () => {
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    const suggestion = await analyzeReportPhoto(file, true, { deps: { encode, send, ...cloudOnly() } });
    expect(suggestion.suggestedTitle).toBe("Black umbrella");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("suggestedTitle"), "data:image/jpeg;base64,/9g=", true, expect.any(Object));
  });

  it("rejects malformed data and unsupported image formats", async () => {
    const send = vi.fn(async () => '{"suggestedTitle":"unsafe"}');
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send, ...cloudOnly() } })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
    await expect(analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, { deps: { encode, send, ...cloudOnly() } })).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("supports abort signal for cancellation", async () => {
    const send = vi.fn(async (_prompt: string, _image: string, _consent: boolean, options?: { signal?: AbortSignal }): Promise<string> => {
      if (options?.signal?.aborted) {
        const error = new Error("Aborted") as Error & { name: string };
        error.name = "AbortError";
        throw error;
      }
      return new Promise((_, reject) => {
        const abortHandler = () => {
          const error = new Error("Aborted") as Error & { name: string };
          error.name = "AbortError";
          reject(error);
        };
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
      });
    });
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    const controller = new AbortController();
    const promise = analyzeReportPhoto(file, true, { deps: { encode, send, ...cloudOnly() }, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes a released cutover category from the model straight through", async () => {
    const cutoverResult = {
      ...result,
      suggestedCategory: "Phones & Tablets", // released by the category cutover
    };
    const send = vi.fn(async () => JSON.stringify(cutoverResult));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send, ...cloudOnly() } })).resolves.toMatchObject({
      suggestedTitle: "Black umbrella",
      suggestedDescription: "A black umbrella with a wooden handle.",
      suggestedCategory: "Phones & Tablets",
    });
  });

  it("rejects an unknown category from the model", async () => {
    const send = vi.fn(async () => JSON.stringify({ ...result, suggestedCategory: "Unrecognized" }));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: {
      encode: async () => "data:image/jpeg;base64,/9g=", send, ...cloudOnly(),
    } })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
  });

  it("never logs photo bytes, EXIF, coordinates or API keys", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await analyzeReportPhoto(file, true, { deps: { encode, send, ...cloudOnly() } });
    // Verify no sensitive data was logged
    const allLogs = [...consoleSpy.mock.calls, ...consoleErrorSpy.mock.calls].flat().join(" ");
    expect(allLogs).not.toContain("base64");
    expect(allLogs).not.toContain("EXIF");
    expect(allLogs).not.toContain("coordinate");
    expect(allLogs).not.toContain("API");
    expect(allLogs).not.toContain("key");
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe("local-first photo suggestions", () => {
  const file = () => new File(["jpeg"], "item.jpg", { type: "image/jpeg" });

  it("returns the on-device analysis without touching OpenRouter when the local model succeeds", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally } });
    expect(suggestion).toMatchObject({ ...result, engine: "on-device" });
    expect(analyzeLocally).toHaveBeenCalledWith(expect.any(File), { signal: undefined });
    expect(send).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it("falls through to OpenRouter when the local analyzer returns null", async () => {
    const analyzeLocally = vi.fn(async () => null);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally } });
    expect(suggestion.suggestedTitle).toBe("Black umbrella");
    expect(analyzeLocally).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls through to OpenRouter when the local analyzer throws a non-abort error", async () => {
    const analyzeLocally = vi.fn(async () => {
      throw new Error("on-device model exploded");
    });
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally } });
    expect(suggestion.suggestedTitle).toBe("Black umbrella");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves MISSING_KEY when both the local model and the cloud key are unavailable", async () => {
    const analyzeLocally = vi.fn(async () => null);
    const send = vi.fn(async () => {
      throw Object.assign(new Error("Connect your OpenRouter API key to use AI."), { code: "MISSING_KEY" });
    });
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), true, {
        deps: { encode, send, analyzeLocally },
      }),
    ).rejects.toMatchObject({ code: "MISSING_KEY" });
    expect(analyzeLocally).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates an AbortError from the local analyzer and never calls cloud", async () => {
    const analyzeLocally = vi.fn(async () => {
      const error = new Error("Aborted") as Error & { name: string };
      error.name = "AbortError";
      throw error;
    });
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally } })).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("photo engine preference", () => {
  const file = () => new File(["jpeg"], "item.jpg", { type: "image/jpeg" });

  it("defaults to automatic local-first (local success skips cloud, tags on-device)", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally } });
    expect(suggestion).toMatchObject({ engine: "on-device" });
    expect(send).not.toHaveBeenCalled();
  });

  it("tags cloud fallback results with the cloud engine", async () => {
    const analyzeLocally = vi.fn(async () => null);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, {
      photoEngine: "automatic",
      deps: { encode, send, analyzeLocally },
    });
    expect(suggestion).toMatchObject({ engine: "cloud", suggestedTitle: "Black umbrella" });
  });

  it("cloud-only skips local entirely", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, {
      photoEngine: "cloud-only",
      deps: { encode, send, analyzeLocally },
    });
    expect(suggestion).toMatchObject({ engine: "cloud" });
    expect(analyzeLocally).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("on-device-only returns local without touching cloud", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, {
      photoEngine: "on-device-only",
      deps: { encode, send, analyzeLocally },
    });
    expect(suggestion).toMatchObject({ ...result, engine: "on-device" });
    expect(send).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it("on-device-only fails closed when local returns null (never falls back to cloud)", async () => {
    const analyzeLocally = vi.fn(async () => null);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "on-device-only", deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ code: "ON_DEVICE_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it("on-device-only fails closed when local throws non-abort (never falls back to cloud)", async () => {
    const analyzeLocally = vi.fn(async () => { throw new Error("model missing"); });
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "on-device-only", deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ code: "ON_DEVICE_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
  });

  it("on-device-only propagates abort and never calls cloud", async () => {
    const analyzeLocally = vi.fn(async () => {
      const error = new Error("Aborted") as Error & { name: string };
      error.name = "AbortError";
      throw error;
    });
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "on-device-only", deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the preference via the getPhotoEngine seam (Lane A store hook)", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const getPhotoEngine = vi.fn(() => "cloud-only" as const);
    await analyzeReportPhoto(file(), true, { deps: { encode, send, analyzeLocally, getPhotoEngine } });
    expect(getPhotoEngine).toHaveBeenCalledTimes(1);
    expect(analyzeLocally).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("normalizes an unknown engine to automatic local-first", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const suggestion = await analyzeReportPhoto(file(), true, {
      photoEngine: "bogus" as never,
      deps: { encode, send, analyzeLocally },
    });
    expect(suggestion).toMatchObject({ engine: "on-device" });
    expect(send).not.toHaveBeenCalled();
  });

  it("consent and image validation run first regardless of engine", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(file(), false, { photoEngine: "cloud-only", deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(analyzeLocally).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await expect(
      analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, {
        photoEngine: "on-device-only",
        deps: { encode, send, analyzeLocally },
      }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("preserves MISSING_KEY and UNUSABLE_RESPONSE on the cloud path", async () => {
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const missing = vi.fn(async () => {
      throw Object.assign(new Error("Connect your OpenRouter API key to use AI."), { code: "MISSING_KEY" });
    });
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "cloud-only", deps: { encode, send: missing, analyzeLocally: async () => null } }),
    ).rejects.toMatchObject({ code: "MISSING_KEY" });
    const unusable = vi.fn(async () => '{"suggestedTitle":"unsafe"}');
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "cloud-only", deps: { encode, send: unusable, analyzeLocally: async () => null } }),
    ).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
  });

  it("getPhotoEngine seam defaults to automatic", async () => {
    const { getPhotoEngine } = await import("./analyzeReportPhoto");
    expect(getPhotoEngine()).toBe("automatic");
  });
});

describe("account-bound cloud sends (real transport, stubbed HTTP)", () => {
  const file = () => new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
  const envelope = () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  // Local fails so the automatic engine reaches the cloud leg; encode is the
  // last step before key resolution, so flipping the session inside it models
  // an account switch mid-flight. `send` is omitted on purpose: reaching for
  // it would bypass the real account-bound resolver under test.
  const localFails = { analyzeLocally: async () => null as null };

  it("sends for the session-owning account and reports the cloud engine", async () => {
    analyzeSession.current = "account-a";
    const fetcher = vi.fn(async () => envelope());
    vi.stubGlobal("fetch", fetcher);
    const suggestion = await analyzeReportPhoto(file(), true, {
      accountId: "account-a",
      deps: { encode: async () => "data:image/jpeg;base64,/9g=", ...localFails },
    });
    expect(suggestion).toMatchObject({ suggestedTitle: "Black umbrella", engine: "cloud" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(analyzeCredentialGet).toHaveBeenCalledWith("account-a", "openrouter");
  });

  it("an account switch before the cloud leg aborts before any network call", async () => {
    analyzeSession.current = "account-a";
    const fetcher = vi.fn(async () => envelope());
    vi.stubGlobal("fetch", fetcher);
    const encode = vi.fn(async () => {
      analyzeSession.current = "account-b";
      return "data:image/jpeg;base64,/9g=";
    });
    await expect(
      analyzeReportPhoto(file(), true, { accountId: "account-a", deps: { encode, ...localFails } }),
    ).rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(analyzeCredentialGet).not.toHaveBeenCalledWith("account-b", expect.anything());
  });

  it("an absent session fails closed even if another account appears mid-flight", async () => {
    analyzeSession.current = null;
    const fetcher = vi.fn(async () => envelope());
    vi.stubGlobal("fetch", fetcher);
    const encode = vi.fn(async () => {
      analyzeSession.current = "account-b";
      return "data:image/jpeg;base64,/9g=";
    });
    await expect(
      analyzeReportPhoto(file(), true, { accountId: "account-a", deps: { encode, ...localFails } }),
    ).rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(analyzeCredentialGet).not.toHaveBeenCalled();
  });

  it("a throwing session read fails closed without touching any key slot", async () => {
    analyzeSession.throws = true;
    const fetcher = vi.fn(async () => envelope());
    vi.stubGlobal("fetch", fetcher);
    await expect(
      analyzeReportPhoto(file(), true, {
        photoEngine: "cloud-only",
        accountId: "account-a",
        deps: { encode: async () => "data:image/jpeg;base64,/9g=", ...localFails },
      }),
    ).rejects.toThrow(/account changed/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(analyzeCredentialGet).not.toHaveBeenCalled();
  });
});
