import { describe, expect, it, vi } from "vitest";
import { analyzeReportPhoto } from "./analyzeReportPhoto";

const result = {
  objectName: "umbrella", suggestedCategory: null, colors: ["black"], visibleBrand: null,
  visibleText: [], identifyingFeatures: ["wooden handle"], suggestedTitle: "Black umbrella",
  suggestedDescription: "A black umbrella with a wooden handle.", uncertainFields: [],
};

describe("OpenRouter photo suggestions", () => {
  it("requires explicit image-sharing consent before reading the image or calling AI", async () => {
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const send = vi.fn(async () => JSON.stringify(result));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, false, { deps: { encode, send } })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(encode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns validated suggestions for user review, without mutating report fields", async () => {
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    const suggestion = await analyzeReportPhoto(file, true, { deps: { encode, send } });
    expect(suggestion.suggestedTitle).toBe("Black umbrella");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("suggestedTitle"), "data:image/jpeg;base64,/9g=", true, expect.any(Object));
  });

  it("rejects malformed data and unsupported image formats", async () => {
    const send = vi.fn(async () => '{"suggestedTitle":"unsafe"}');
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send } })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
    await expect(analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, { deps: { encode, send } })).rejects.toMatchObject({ code: "INVALID_IMAGE" });
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
    const promise = analyzeReportPhoto(file, true, { deps: { encode, send }, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps useful text while dropping an unreleased category from the model", async () => {
    const unreleasedResult = {
      ...result,
      suggestedCategory: "Phones & Tablets", // not in RELEASED_CATEGORIES
    };
    const send = vi.fn(async () => JSON.stringify(unreleasedResult));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: { encode, send } })).resolves.toMatchObject({
      suggestedTitle: "Black umbrella",
      suggestedDescription: "A black umbrella with a wooden handle.",
      suggestedCategory: null,
      categoryUnavailable: true,
    });
  });

  it("rejects an unknown category from the model", async () => {
    const send = vi.fn(async () => JSON.stringify({ ...result, suggestedCategory: "Unrecognized" }));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { deps: {
      encode: async () => "data:image/jpeg;base64,/9g=", send,
    } })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
  });

  it("never logs photo bytes, EXIF, coordinates or API keys", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => JSON.stringify(result));
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await analyzeReportPhoto(file, true, { deps: { encode, send } });
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
