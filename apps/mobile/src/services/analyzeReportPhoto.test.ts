import { describe, expect, it, vi } from "vitest";
import { analyzeReportPhoto } from "./analyzeReportPhoto";

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
    expect(suggestion).toEqual(result);
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
