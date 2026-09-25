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
    await expect(analyzeReportPhoto(file, false, { encode, send })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(encode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns validated suggestions for user review, without mutating report fields", async () => {
    const send = vi.fn(async () => JSON.stringify(result));
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    const suggestion = await analyzeReportPhoto(file, true, {
      encode: async () => "data:image/jpeg;base64,/9g=", send,
    });
    expect(suggestion.suggestedTitle).toBe("Black umbrella");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("suggestedTitle"), "data:image/jpeg;base64,/9g=", true);
  });

  it("rejects malformed data and unsupported image formats", async () => {
    const send = vi.fn(async () => '{"suggestedTitle":"unsafe"}');
    const encode = vi.fn(async () => "data:image/jpeg;base64,/9g=");
    const file = new File(["jpeg"], "item.jpg", { type: "image/jpeg" });
    await expect(analyzeReportPhoto(file, true, { encode, send })).rejects.toMatchObject({ code: "UNUSABLE_RESPONSE" });
    await expect(analyzeReportPhoto(new File(["gif"], "item.gif", { type: "image/gif" }), true, { encode, send })).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
});
