import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeReportPhoto, hasUsefulPhotoSignal } from "./analyzeReportPhoto";

// Session + credential boundary for the real-send account-binding tests.
// resolveAccountOpenRouterKey mirrors the production contract exactly
// (single session lookup, fail closed — pinned for real in
// aiCredentials.test.ts); the credentialGet spy proves a foreign account's
// slot is never even read on a switch.
const { analyzeSession, analyzeCredentialGet, diagSpy, normalizedMock } = vi.hoisted(() => ({
  analyzeSession: { current: null as string | null, throws: false },
  analyzeCredentialGet: vi.fn(async (_accountId: string, _provider: string) => "test-only-placeholder"),
  // Records every diagnostic the flow emits so the no-byte-logging contract
  // can be asserted against the real payload set (not a vacuous empty spy).
  diagSpy: vi.fn<(event: string, fields?: Record<string, unknown>, opts?: unknown) => void>(),
  // Decoding seam: keeps the real encodePhoto pipeline running (so its stage
  // diagnostics are exercised) without a real image decoder in the test env.
  normalizedMock: vi.fn(async () => ({
    blob: new Blob(["photo"], { type: "image/jpeg" }),
    mimeType: "image/jpeg",
    width: 100,
    height: 100,
  })),
}));
vi.mock("./image", () => ({ normalizeImage: normalizedMock }));
vi.mock("./diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diag")>()),
  diag: diagSpy,
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
  diagSpy.mockClear();
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

  it("accepts sparse model output via the tolerant parser; truly unusable output still fails", async () => {
    // Sparse (single-key) output stays usable under the tolerant parser.
    const sparse = vi.fn(async () => '{"suggestedTitle":"Black umbrella"}');
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send: sparse, ...cloudOnly() } })).resolves.toMatchObject({
      suggestedTitle: "Black umbrella",
    });
    // No JSON at all is still UNUSABLE.
    const garbage = vi.fn(async () => "not json at all");
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send: garbage, ...cloudOnly() } })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
    // GIF sources normalize first and stay usable (no pre-gate rejection).
    const gifSend = vi.fn(async () => JSON.stringify(result));
    await expect(analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, { deps: { encode, send: gifSend, ...cloudOnly() } })).resolves.toMatchObject({
      suggestedTitle: "Black umbrella",
    });
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

  it("drops an unknown category to null but keeps the usable suggestion", async () => {
    const send = vi.fn(async () => JSON.stringify({ ...result, suggestedCategory: "Unrecognized" }));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: {
      encode: async () => "data:image/jpeg;base64,/9g=", send, ...cloudOnly(),
    } })).resolves.toMatchObject({ suggestedTitle: "Black umbrella", suggestedCategory: null });
  });

  it("never logs photo bytes, EXIF, coordinates or API keys on any engine path", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const IMAGE_PAYLOAD = "data:image/jpeg;base64,/9j/SECRET_PHOTO_BYTES==";
    // Exercise the REAL encodePhoto (normalize seam mocked) so the derivative
    // stage is included in the scanned payload set.
    normalizedMock.mockResolvedValue({
      blob: new Blob(["photo"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 100,
      height: 100,
    });
    const send = vi.fn(async () => JSON.stringify(result));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    // Cloud leg with the real derivative pipeline (send stubbed, no encode seam).
    await analyzeReportPhoto(file, true, { deps: { send, analyzeLocally: async () => null } });
    // On-device leg (local seam returns a full analysis).
    await analyzeReportPhoto(file, true, { deps: { encode: async () => IMAGE_PAYLOAD, send, analyzeLocally: async () => result } });
    // Non-vacuous: the flow really emitted stage diagnostics during those runs.
    const events = diagSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain("photo.source_accept");
    expect(events).toContain("photo.derivative_prep");
    expect(events).toContain("photo.cloud_send");
    expect(events).toContain("photo.useful_signal");
    // Every diagnostic name and payload is scanned for photo bytes / EXIF /
    // coordinates / key material — counts and booleans only, never content.
    const forbidden = [/base64/i, /exif/i, /gps/i, /latitude/i, /longitude/i, /sk-or-/i, /api[_-]?key/i, /SECRET_PHOTO_BYTES/, /data:image/i];
    for (const [event, fields, opts] of diagSpy.mock.calls) {
      const serialized = JSON.stringify([event, fields ?? {}, opts ?? {}]);
      for (const pattern of forbidden) {
        expect(serialized, `diag payload for ${String(event)} leaked ${String(pattern)}`).not.toMatch(pattern);
      }
    }
    const allLogs = [...consoleSpy.mock.calls, ...consoleErrorSpy.mock.calls].flat().join(" ");
    for (const pattern of forbidden) {
      expect(allLogs).not.toMatch(pattern);
    }
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

  it("consent runs first; GIF/image sources normalize instead of pre-gate rejection", async () => {
    const analyzeLocally = vi.fn(async () => result);
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    await expect(
      analyzeReportPhoto(file(), false, { photoEngine: "cloud-only", deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(analyzeLocally).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // GIF is no longer INVALID_IMAGE up front: on-device-only analyzes it.
    await expect(
      analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, {
        photoEngine: "on-device-only",
        deps: { encode, send, analyzeLocally },
      }),
    ).resolves.toMatchObject({ engine: "on-device" });
  });

  it("preserves MISSING_KEY and UNUSABLE_RESPONSE on the cloud path", async () => {
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const missing = vi.fn(async () => {
      throw Object.assign(new Error("Connect your OpenRouter API key to use AI."), { code: "MISSING_KEY" });
    });
    await expect(
      analyzeReportPhoto(file(), true, { photoEngine: "cloud-only", deps: { encode, send: missing, analyzeLocally: async () => null } }),
    ).rejects.toMatchObject({ code: "MISSING_KEY" });
    const unusable = vi.fn(async () => "definitely not json");
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

describe("useful-signal gating", () => {
  const file = () => new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
  const emptyAnalysis = {
    objectName: null, suggestedCategory: null, colors: [], visibleBrand: null,
    visibleText: [], identifyingFeatures: [], suggestedTitle: null,
    suggestedDescription: null, uncertainFields: [],
  };

  it("hasUsefulPhotoSignal is true only for a title, description or category the panel can draft", () => {
    expect(hasUsefulPhotoSignal({ suggestedTitle: "Black umbrella", suggestedDescription: null, suggestedCategory: null })).toBe(true);
    expect(hasUsefulPhotoSignal({ suggestedTitle: "  ", suggestedDescription: null, suggestedCategory: null })).toBe(false);
    expect(hasUsefulPhotoSignal({ suggestedTitle: null, suggestedDescription: "A black umbrella.", suggestedCategory: null })).toBe(true);
    expect(hasUsefulPhotoSignal({ suggestedTitle: null, suggestedDescription: null, suggestedCategory: "Phones & Tablets" })).toBe(true);
    expect(hasUsefulPhotoSignal({ suggestedTitle: null, suggestedDescription: null, suggestedCategory: null })).toBe(false);
    expect(hasUsefulPhotoSignal({ suggestedTitle: "", suggestedDescription: "   ", suggestedCategory: "" })).toBe(false);
  });

  it("automatic mode treats an empty local answer as no answer and falls back to cloud", async () => {
    const analyzeLocally = vi.fn(async () => emptyAnalysis);
    const send = vi.fn(async () => JSON.stringify(result));
    const suggestion = await analyzeReportPhoto(file(), true, { deps: { analyzeLocally, send } });
    expect(suggestion).toMatchObject({ engine: "cloud", suggestedTitle: "Black umbrella" });
    expect(analyzeLocally).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    // Stage contract: the fallback is attributed, not silent.
    expect(diagSpy.mock.calls).toContainEqual(["photo.cloud_fallback", { reason: "local-empty" }, {}]);
  });

  it("on-device-only refuses an empty local answer as UNUSABLE_RESPONSE without cloud", async () => {
    const send = vi.fn(async () => JSON.stringify(result));
    await expect(
      analyzeReportPhoto(file(), true, {
        photoEngine: "on-device-only",
        deps: { analyzeLocally: async () => emptyAnalysis, send },
      }),
    ).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
    expect(send).not.toHaveBeenCalled();
  });

  it("cloud parses an all-null model answer but still refuses it as UNUSABLE_RESPONSE", async () => {
    const send = vi.fn(async () => JSON.stringify(emptyAnalysis));
    await expect(
      analyzeReportPhoto(file(), true, {
        photoEngine: "cloud-only",
        deps: { analyzeLocally: async () => null, send },
      }),
    ).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
  });

  it("restores canonical category casing from the local analyzer and drops unknown categories", async () => {
    const send = vi.fn(async () => JSON.stringify(result));
    const wrongCase = await analyzeReportPhoto(file(), true, {
      photoEngine: "on-device-only",
      deps: { analyzeLocally: async () => ({ ...emptyAnalysis, suggestedTitle: "Phone", suggestedCategory: "phones & tablets" }), send },
    });
    expect(wrongCase.suggestedCategory).toBe("Phones & Tablets");
    const unknown = await analyzeReportPhoto(file(), true, {
      photoEngine: "on-device-only",
      deps: { analyzeLocally: async () => ({ ...emptyAnalysis, suggestedTitle: "Phone", suggestedCategory: "Portal Gun" }), send },
    });
    expect(unknown.suggestedCategory).toBeNull();
    expect(unknown.suggestedTitle).toBe("Phone");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("abort propagation through every stage", () => {
  const file = () => new File(["jpeg"], "item.jpg", { type: "image/jpeg" });

  it("a pre-aborted signal stops before local, encode, or send", async () => {
    const controller = new AbortController();
    controller.abort();
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const send = vi.fn(async () => JSON.stringify(result));
    const analyzeLocally = vi.fn(async () => result);
    await expect(
      analyzeReportPhoto(file(), true, { signal: controller.signal, deps: { encode, send, analyzeLocally } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(analyzeLocally).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(diagSpy.mock.calls.some((call) => call[0] === "photo.source_accept")).toBe(false);
  });

  it("forwards the caller's signal into derivative preparation", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const encode = vi.fn(async (_file: File, opts?: { signal?: AbortSignal }) => {
      seen = opts?.signal;
      return "data:image/jpeg;base64,/9g=";
    });
    await analyzeReportPhoto(file(), true, {
      signal: controller.signal,
      deps: { encode, send: async () => JSON.stringify(result), analyzeLocally: async () => null },
    });
    expect(seen).toBe(controller.signal);
  });

  it("an abort during derivative prep blocks the network send", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => {
      controller.abort();
      return "data:image/jpeg;base64,/9g=";
    });
    await expect(
      analyzeReportPhoto(file(), true, {
        signal: controller.signal,
        deps: { encode, send, analyzeLocally: async () => null },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
    expect(diagSpy.mock.calls.some((call) => call[0] === "photo.cloud_send")).toBe(false);
  });
});
