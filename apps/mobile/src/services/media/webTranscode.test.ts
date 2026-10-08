import { afterEach, describe, expect, it, vi } from "vitest";
import { transcodeImageForWeb } from "./webTranscode";

afterEach(() => vi.unstubAllGlobals());
describe("web target decode", () => {
  it("requests oriented target-size decoding, encodes only target pixels and closes the bitmap", async () => {
    const close = vi.fn();
    const bitmap = { width: 1442, height: 1920, close };
    const decode = vi.fn(async (_blob: Blob, _options: ImageBitmapOptions) => bitmap);
    const draw = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage: draw }; }
      async convertToBlob() { return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }
    });
    const out = await transcodeImageForWeb({ bytes: new Uint8Array([255, 216, 255]), sniffed: "jpeg", targetWidth: 1442, targetHeight: 1920, mimeType: "image/jpeg", quality: 0.82 });
    expect(decode.mock.calls[0]?.[1]).toEqual({ imageOrientation: "from-image", resizeWidth: 1442, resizeHeight: 1920, resizeQuality: "high" });
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 1442, 1920);
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
    expect(close).toHaveBeenCalledOnce();
  });
  it("refuses unsupported decoder environments rather than silently doing full-size decode", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(transcodeImageForWeb({ bytes: new Uint8Array(3), sniffed: "jpeg", targetWidth: 32, targetHeight: 32, mimeType: "image/jpeg", quality: 0.82 })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });
});
