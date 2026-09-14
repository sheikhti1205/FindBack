import { describe, expect, it, vi } from "vitest";
import {
  MAX_EDGE,
  fitWithin,
  normalizeImage,
  outputTypeFor,
  type ImageDeps,
} from "./image";

function deps(overrides: Partial<ImageDeps> = {}): ImageDeps {
  return {
    decode: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 4000, height: 2000 })),
    encode: vi.fn(async () => new Blob(["out"], { type: "image/jpeg" })),
    webpSupported: true,
    ...overrides,
  };
}

describe("fitWithin", () => {
  it("caps the longest edge without enlarging", () => {
    expect(fitWithin(MAX_EDGE, 4000, 2000)).toEqual({ width: 1920, height: 960 });
    expect(fitWithin(MAX_EDGE, 800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("caps portrait images too", () => {
    expect(fitWithin(MAX_EDGE, 1000, 4000)).toEqual({ width: 480, height: 1920 });
  });
});

describe("outputTypeFor", () => {
  it("keeps PNG lossless, JPEG lossy, WebP when supported", () => {
    expect(outputTypeFor("image/png", true)).toEqual({ mimeType: "image/png", quality: null });
    expect(outputTypeFor("image/jpeg", true)).toEqual({ mimeType: "image/jpeg", quality: 0.82 });
    expect(outputTypeFor("image/webp", true)).toEqual({ mimeType: "image/webp", quality: 0.82 });
  });

  it("falls back to PNG when WebP encoding is unavailable", () => {
    expect(outputTypeFor("image/webp", false)).toEqual({ mimeType: "image/png", quality: null });
  });
});

describe("normalizeImage", () => {
  it("scales and re-encodes a JPEG with orientation applied by the decoder", async () => {
    const d = deps();
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });

    const result = await normalizeImage(file, d);

    expect(d.decode).toHaveBeenCalledWith(file);
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 1920, 960, "image/jpeg", 0.82);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(960);
  });

  it("re-encodes PNG losslessly", async () => {
    const d = deps();
    const file = new File(["x"], "alpha.png", { type: "image/png" });

    await normalizeImage(file, d);

    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 1920, 960, "image/png", null);
  });

  it("passes a GIF through untouched to preserve animation", async () => {
    const d = deps();
    const file = new File(["gif"], "anim.gif", { type: "image/gif" });

    const result = await normalizeImage(file, d);

    expect(d.encode).not.toHaveBeenCalled();
    expect(result.blob).toBe(file);
    expect(result.mimeType).toBe("image/gif");
  });

  it("closes the decoded handle", async () => {
    const close = vi.fn();
    const d = deps({
      decode: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 100, height: 100, close })),
    });

    await normalizeImage(new File(["x"], "a.png", { type: "image/png" }), d);

    expect(close).toHaveBeenCalled();
  });

  it("rejects unsupported types", async () => {
    await expect(
      normalizeImage(new File(["x"], "a.svg", { type: "image/svg+xml" }), deps()),
    ).rejects.toThrow("Unsupported image type");
  });
});
