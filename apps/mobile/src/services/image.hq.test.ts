// @vitest-environment jsdom
/**
 * H1-motion (c), option A: the High Quality Photo flag drives the real
 * browser encode path (`services/image.ts`).
 *
 * - Default tier follows the persisted flag: standard 0.82 vs HQ 0.92.
 * - Encoder input (quality arg) changes with the preference — no reload.
 * - Explicit per-call tiers still win (tests, special flows).
 * - PNG stays lossless (quality null) and dimension caps stay hard in both tiers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  PHOTO_QUALITY_HIGH,
  PHOTO_QUALITY_STANDARD,
  currentPhotoQuality,
  saveAppearance,
} from "../appearance";
import { MAX_EDGE, normalizeImage, outputTypeFor, type ImageDeps } from "./image";

function deps(overrides: Partial<ImageDeps> = {}): ImageDeps {
  return {
    decode: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 4000, height: 2000 })),
    encode: vi.fn(async () => new Blob(["out"], { type: "image/jpeg" })),
    webpSupported: true,
    ...overrides,
  };
}

function encodeOf(d: ImageDeps): ReturnType<typeof vi.fn> {
  return d.encode as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  localStorage.clear();
});

describe("outputTypeFor honors the High Quality Photo flag", () => {
  it("defaults to the standard 0.82 tier when the flag is off", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: false });
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_STANDARD);
    expect(outputTypeFor("image/jpeg", true)).toEqual({ mimeType: "image/jpeg", quality: 0.82 });
    expect(outputTypeFor("image/webp", true)).toEqual({ mimeType: "image/webp", quality: 0.82 });
  });

  it("defaults to the HQ 0.92 tier when the flag is on", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_HIGH);
    expect(outputTypeFor("image/jpeg", true)).toEqual({ mimeType: "image/jpeg", quality: 0.92 });
    expect(outputTypeFor("image/webp", true)).toEqual({ mimeType: "image/webp", quality: 0.92 });
  });

  it("keeps PNG lossless in both tiers and falls back to PNG without webp", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    expect(outputTypeFor("image/png", true)).toEqual({ mimeType: "image/png", quality: null });
    expect(outputTypeFor("image/webp", false)).toEqual({ mimeType: "image/png", quality: null });
  });

  it("lets an explicit tier override the persisted flag", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    expect(outputTypeFor("image/jpeg", true, PHOTO_QUALITY_STANDARD)).toEqual({
      mimeType: "image/jpeg",
      quality: 0.82,
    });
  });
});

describe("normalizeImage encodes at the persisted tier", () => {
  it("passes 0.82 to the encoder when HQ is off", async () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: false });
    const d = deps();
    const result = await normalizeImage(new File(["x"], "photo.jpg", { type: "image/jpeg" }), d);
    expect(encodeOf(d)).toHaveBeenCalledWith(expect.anything(), 1920, 960, "image/jpeg", 0.82);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(960);
  });

  it("passes 0.92 to the encoder when HQ is on — same caps", async () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    const d = deps();
    const result = await normalizeImage(new File(["x"], "photo.jpg", { type: "image/jpeg" }), d);
    expect(encodeOf(d)).toHaveBeenCalledWith(expect.anything(), 1920, 960, "image/jpeg", 0.92);
    // Hard caps don't move with the tier.
    expect(result.width).toBeLessThanOrEqual(MAX_EDGE);
    expect(result.height).toBeLessThanOrEqual(MAX_EDGE);
  });

  it("lets an explicit quality override the persisted flag", async () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    const d = deps();
    await normalizeImage(new File(["x"], "photo.jpg", { type: "image/jpeg" }), d, {
      quality: PHOTO_QUALITY_STANDARD,
    });
    expect(encodeOf(d)).toHaveBeenCalledWith(expect.anything(), 1920, 960, "image/jpeg", 0.82);
  });
});
