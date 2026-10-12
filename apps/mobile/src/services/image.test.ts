import { describe, expect, it, vi } from "vitest";
import {
  DECODE_TOO_LARGE,
  MAX_DECODE_PIXELS,
  MAX_EDGE,
  DecodeError,
  fitWithin,
  normalizeImage,
  outputTypeFor,
  type ImageDeps,
} from "./image";
import { ACCEPTED_STILL_MIME_TYPES, MAX_EDGE as POLICY_MAX_EDGE } from "./media/mediaPolicy";
import { IMPORT_MAX_DECODE_PIXELS, IMPORT_MAX_EDGE } from "./media/importImage";

/** Minimal JPEG header declaring the given dimensions (SOI + SOF0 + EOI). */
function jpegHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    255, 216, 255, 192, 0, 11, 8,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    1, 1, 17, 0, 255, 217,
  ]);
}

/** Minimal GIF header declaring the given dimensions. */
function gifHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    71, 73, 70, 56, 57, 97,
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
    0, 0, 0,
  ]);
}

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

describe("canonical media policy bindings (L-CONSOLIDATE)", () => {
  it("re-exports the single longest-edge cap (no second 1920 to drift)", () => {
    expect(MAX_EDGE).toBe(POLICY_MAX_EDGE);
    expect(MAX_EDGE).toBe(IMPORT_MAX_EDGE);
  });

  it("keeps the web decode bound tighter than the pathological ceiling", () => {
    // The web normalize path decodes in a constrained renderer: its working
    // set must never exceed the byte pipeline's absurdity ceiling, and the
    // two bounds overlap (a web-bound breach is always pathological too).
    expect(MAX_DECODE_PIXELS).toBeLessThan(IMPORT_MAX_DECODE_PIXELS);
    expect(MAX_DECODE_PIXELS).toBe(30_000_000);
  });

  it("accepts exactly the canonical still set (no local MIME list)", async () => {
    for (const mime of ACCEPTED_STILL_MIME_TYPES) {
      const kinder = deps();
      const probeable: Record<string, Uint8Array<ArrayBuffer>> = {
        "image/jpeg": jpegHeader(1, 1),
        "image/png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      };
      const header = probeable[mime] ?? new Uint8Array([0]);
      await expect(
        normalizeImage(new File([header], `a.${mime.split("/")[1]}`, { type: mime }), kinder),
      ).resolves.toBeTruthy();
    }
    await expect(
      normalizeImage(new File(["x"], "a.svg", { type: "image/svg+xml" }), deps()),
    ).rejects.toThrow("Unsupported image type");
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

  it("downsamples a 50 MP photo at decode time instead of rejecting it", async () => {
    // 10000x5000 = 50M px > 30M bound: legitimate high-resolution photos are
    // accepted via a bounded decode, not refused for their dimensions.
    const d = deps({
      decode: vi.fn(async (_file: File, opts?: { resizeWidth?: number; resizeHeight?: number }) => ({
        source: {} as CanvasImageSource,
        width: opts?.resizeWidth ?? 10000,
        height: opts?.resizeHeight ?? 5000,
      })),
    });
    const file = new File([jpegHeader(10000, 5000)], "big.jpg", { type: "image/jpeg" });

    const result = await normalizeImage(file, d);

    const scale = Math.sqrt(MAX_DECODE_PIXELS / 50_000_000);
    const expectedWidth = Math.floor(10000 * scale);
    const expectedHeight = Math.floor(5000 * scale);
    expect(expectedWidth * expectedHeight).toBeLessThanOrEqual(MAX_DECODE_PIXELS);
    expect(d.decode).toHaveBeenCalledWith(file, { resizeWidth: expectedWidth, resizeHeight: expectedHeight });
    expect(d.encode).toHaveBeenCalled();
    expect(result.width).toBeLessThanOrEqual(1920);
  });

  it("refuses the giant bitmap when the platform cannot downsample at decode", async () => {
    // Unprobeable bytes + a decoder that ignores resize opts: the full-size
    // bitmap is released and an actionable error is thrown before encode.
    const close = vi.fn();
    const d = deps({
      decode: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 10000, height: 5000, close })),
    });
    await expect(
      normalizeImage(new File(["x"], "big.jpg", { type: "image/jpeg" }), d),
    ).rejects.toThrow(DECODE_TOO_LARGE);
    expect(close).toHaveBeenCalled();
    expect(d.encode).not.toHaveBeenCalled();
  });

  it("fails fast on an over-bound GIF instead of decoding it", async () => {
    // Animation cannot survive downsampling, so an over-bound GIF is rejected
    // pre-decode rather than OOMing the renderer.
    const decode = vi.fn();
    const d = deps({ decode });
    await expect(
      normalizeImage(new File([gifHeader(10000, 5000)], "anim.gif", { type: "image/gif" }), d),
    ).rejects.toThrow(DECODE_TOO_LARGE);
    expect(decode).not.toHaveBeenCalled();
  });

  it("marks an attempted-but-refused decode as rejected", async () => {
    const d = deps({ decode: vi.fn(async () => { throw new Error("boom"); }) });
    const failure = await normalizeImage(new File(["x"], "a.jpg", { type: "image/jpeg" }), d).catch((err) => err);
    expect(failure).toBeInstanceOf(DecodeError);
    expect((failure as DecodeError).kind).toBe("rejected");
    expect((failure as DecodeError).message).toBe("boom");
  });

  it("keeps a genuinely missing decoder marked unavailable", async () => {
    // No createImageBitmap (jsdom) and no Image constructor: the platform
    // cannot decode at all, so callers may still use verified originals.
    vi.stubGlobal("Image", undefined);
    try {
      const failure = await normalizeImage(
        new File([jpegHeader(1, 1)], "a.jpg", { type: "image/jpeg" }),
      ).catch((err) => err);
      expect(failure).toBeInstanceOf(DecodeError);
      expect((failure as DecodeError).kind).toBe("unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
