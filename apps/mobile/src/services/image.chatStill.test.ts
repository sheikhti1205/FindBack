import { describe, expect, it, vi } from "vitest";
import { normalizeImage, type ImageDeps } from "./image";
import { buildGif, buildPng } from "./media/__fixtures__/synthetic";

function codecs(width = 32, height = 16) {
  const close = vi.fn();
  const deps: ImageDeps = {
    decode: vi.fn(async (_file, opts) => ({ source: {} as CanvasImageSource,
      width: opts?.resizeWidth ?? width, height: opts?.resizeHeight ?? height, close })),
    encode: vi.fn(async (_source, w, h, mime) => new Blob([new Uint8Array(buildPng(w, h))], { type: mime })),
    webpSupported: true,
  };
  return { deps, close };
}

describe("canonical normalization's explicit still derivative", () => {
  it("keeps existing GIF preservation as the default", async () => {
    const file = new File([new Uint8Array(buildGif(32, 16, { animated: true }))], "animation.gif", { type: "image/gif" });
    const { deps, close } = codecs();
    const result = await normalizeImage(file, deps);
    expect(result.blob).toBe(file);
    expect(result.mimeType).toBe("image/gif");
    expect(deps.encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("encodes an explicitly requested still instead of forwarding GIF bytes", async () => {
    const file = new File([new Uint8Array(buildGif(32, 16, { animated: true }))], "animation.gif", { type: "image/gif" });
    const { deps, close } = codecs();
    const result = await normalizeImage(file, deps, { animation: "still" });
    expect(result.mimeType).toBe("image/png");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(buildPng(32, 16));
    expect(result.blob).not.toBe(file);
    expect(close).toHaveBeenCalledOnce();
  });

  it("downsamples a large GIF for still use instead of applying the preserve-animation rejection", async () => {
    const file = new File([new Uint8Array(buildGif(8000, 6000, { animated: true }))], "camera.gif", { type: "image/gif" });
    const { deps, close } = codecs(8000, 6000);
    const result = await normalizeImage(file, deps, { animation: "still", maxDecodePixels: 3_000_000 });
    expect(deps.decode).toHaveBeenCalledWith(file, { resizeWidth: 2000, resizeHeight: 1500 });
    expect([result.width, result.height]).toEqual([1920, 1440]);
    expect(close).toHaveBeenCalledOnce();
  });
});
