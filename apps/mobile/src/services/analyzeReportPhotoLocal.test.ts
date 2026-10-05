import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeImage = vi.hoisted(() => vi.fn());
vi.mock("./image", () => ({ normalizeImage }));

import {
  analyzeReportPhotoLocally,
  PHOTO_CATEGORY_CANONICALS,
  PHOTO_INSTRUCTION,
} from "./analyzeReportPhotoLocal";

const ANALYSIS = {
  objectName: "umbrella",
  suggestedCategory: null,
  colors: ["black"],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: ["wooden handle"],
  suggestedTitle: "Black umbrella",
  suggestedDescription: "A black umbrella with a wooden handle.",
  uncertainFields: [],
};

function normalized(bytes = [1, 2, 3]) {
  return {
    blob: new Blob([new Uint8Array(bytes)]),
    mimeType: "image/jpeg",
    width: 1200,
    height: 900,
  };
}

describe("analyzeReportPhotoLocally", () => {
  beforeEach(() => {
    normalizeImage.mockReset();
    normalizeImage.mockResolvedValue(normalized());
  });

  it("encodes base64 without a data-URL prefix and routes analyze-image with the shared prompt", async () => {
    const route = vi.fn(async () => ({ ok: true, value: { text: JSON.stringify(ANALYSIS) } }));
    const result = await analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route });
    expect(result).toEqual(ANALYSIS);
    expect(route).toHaveBeenCalledTimes(1);
    const [taskId, input, ctx] = route.mock.calls[0] as unknown as [
      string,
      { prompt: string; imageBase64: string },
      { traceId: string; consent: boolean },
    ];
    expect(taskId).toBe("analyze-image");
    expect(input.prompt).toBe(PHOTO_INSTRUCTION);
    expect(input.imageBase64).toBe("AQID");
    expect(input.imageBase64.startsWith("data:")).toBe(false);
    expect(ctx.consent).toBe(true);
    expect(ctx.traceId).toEqual(expect.any(String));
  });

  it("returns null (never throws) when the route is not ok", async () => {
    const route = vi.fn(async () => ({ ok: false }));
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).resolves.toBeNull();
  });

  it("returns null when the routed text does not parse into a VlmAnalysis", async () => {
    const route = vi.fn(async () => ({ ok: true, value: { text: "not json" } }));
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).resolves.toBeNull();
  });

  it("returns null when the model value carries no text", async () => {
    const route = vi.fn(async () => ({ ok: true, value: {} }));
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).resolves.toBeNull();
  });

  it("returns null when normalization fails for a non-abort reason", async () => {
    normalizeImage.mockRejectedValueOnce(new Error("Unsupported image type"));
    const route = vi.fn(async () => ({ ok: true, value: { text: JSON.stringify(ANALYSIS) } }));
    await expect(
      analyzeReportPhotoLocally(new File(["gif"], "item.gif", { type: "image/gif" }), { route }),
    ).resolves.toBeNull();
    expect(route).not.toHaveBeenCalled();
  });

  it("returns null when normalization exceeds the local size guard", async () => {
    normalizeImage.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array(2_000_001)]),
      mimeType: "image/jpeg",
      width: 1200,
      height: 900,
    });
    const route = vi.fn(async () => ({ ok: true, value: { text: JSON.stringify(ANALYSIS) } }));
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).resolves.toBeNull();
    expect(route).not.toHaveBeenCalled();
  });

  it("rethrows AbortError instead of reporting unavailability", async () => {
    normalizeImage.mockRejectedValueOnce(
      Object.assign(new Error("Aborted"), { name: "AbortError" }),
    );
    const route = vi.fn(async () => ({ ok: true, value: { text: JSON.stringify(ANALYSIS) } }));
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows AbortError raised by the route", async () => {
    const route = vi.fn(async () => {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    });
    await expect(
      analyzeReportPhotoLocally(new File(["jpeg"], "item.jpg", { type: "image/jpeg" }), { route }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("exposes the same 9-field instruction and catalog canonical allowlist the cloud path uses", () => {
    for (const field of [
      "objectName",
      "suggestedCategory",
      "colors",
      "visibleBrand",
      "visibleText",
      "identifyingFeatures",
      "suggestedTitle",
      "suggestedDescription",
      "uncertainFields",
    ]) {
      expect(PHOTO_INSTRUCTION).toContain(field);
    }
    expect(PHOTO_CATEGORY_CANONICALS.length).toBeGreaterThan(0);
  });
});
