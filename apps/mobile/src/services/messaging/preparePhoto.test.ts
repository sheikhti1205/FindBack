import { describe, expect, it, vi } from "vitest";
import type { ImageDeps } from "../image";
import { buildGif, buildPng } from "../media/__fixtures__/synthetic";
import { SOURCE_MAX_BYTES } from "../media/mediaPolicy";
import { MEDIA_MAX_BYTES } from "./media";
import { prepareMessagingPhoto } from "./preparePhoto";

function codecs(output = buildPng(32, 16)): ImageDeps {
  return { decode: async () => ({ source: {} as CanvasImageSource, width: 32, height: 16 }),
    encode: async () => new Blob([new Uint8Array(output)], { type: "image/png" }), webpSupported: true };
}
const source = () => new File([new Uint8Array(buildGif(32, 16, { animated: true }))], "synthetic.gif", { type: "image/gif" });

describe("private chat photo preparation", () => {
  it("returns exact supported still bytes and their digest, never the animated source", async () => {
    const result = await prepareMessagingPhoto(source(), {}, codecs());
    expect(new Uint8Array(result.bytes)).toEqual(buildPng(32, 16));
    expect(result).toMatchObject({ mime: "image/png", width: 32, height: 16, byteSize: buildPng(32, 16).length });
    const hash = await crypto.subtle.digest("SHA-256", result.bytes);
    expect(result.sha256).toBe([...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect(result).not.toHaveProperty("url");
  });

  it("refuses an over-cap source before reading a byte or decoding", async () => {
    const file = source(), slice = vi.spyOn(file, "slice");
    Object.defineProperty(file, "size", { value: SOURCE_MAX_BYTES + 1 });
    const deps = codecs(), decode = vi.spyOn(deps, "decode");
    await expect(prepareMessagingPhoto(file, {}, deps)).rejects.toThrow(/100 MB source limit/);
    expect(slice).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
  });

  it("sniffs a generic file through a bounded header rather than reading the whole source", async () => {
    const file = new File([new Uint8Array(buildPng(32, 16))], "synthetic.bin", { type: "application/octet-stream" });
    const slice = vi.spyOn(file, "slice"), fullRead = vi.spyOn(file, "arrayBuffer");
    expect((await prepareMessagingPhoto(file, {}, codecs())).mime).toBe("image/png");
    expect(slice.mock.calls.every(([start, end]) => start === 0 && end! <= 65536)).toBe(true);
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("refuses a claimed JPEG containing GIF before decoding", async () => {
    const deps = codecs(), decode = vi.spyOn(deps, "decode");
    const file = new File([new Uint8Array(buildGif(32, 16))], "mislabeled.jpg", { type: "image/jpeg" });
    await expect(prepareMessagingPhoto(file, {}, deps)).rejects.toThrow(/contents|re-save/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([new Uint8Array([1, 2, 3]), buildPng(31, 16), buildPng(32, 16, { animated: true })])(
    "does not accept contradictory or animated encoder output", async (encoded) => {
      await expect(prepareMessagingPhoto(source(), {}, codecs(encoded))).rejects.toThrow(/prepare|re-save/i);
    });

  it("never falls back to the original when the codec fails with a private path", async () => {
    const deps = codecs(); deps.decode = async () => { throw new Error("content://private/account/source"); };
    await expect(prepareMessagingPhoto(source(), {}, deps)).rejects.toThrow(/prepare|re-save/i);
    await expect(prepareMessagingPhoto(source(), {}, deps)).rejects.not.toThrow(/content:|private\/account/);
  });

  it("honors a pre-aborted selection before reading or decoding", async () => {
    const file = source(), slice = vi.spyOn(file, "slice"), controller = new AbortController();
    controller.abort();
    await expect(prepareMessagingPhoto(file, { signal: controller.signal }, codecs())).rejects.toThrow(/abort/i);
    expect(slice).not.toHaveBeenCalled();
  });

  it("stops a hung codec on the stage budget, without shipping source bytes", async () => {
    const deps = codecs(); deps.decode = () => new Promise(() => {});
    await expect(prepareMessagingPhoto(source(), { timeoutMs: 10 }, deps)).rejects.toThrow(/prepare|try again/i);
  });

  it("refuses empty input without invoking a decoder", async () => {
    const deps = codecs(), decode = vi.spyOn(deps, "decode");
    await expect(prepareMessagingPhoto(new File([], "empty.png", { type: "image/png" }), {}, deps)).rejects.toThrow(/prepare/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses an oversized encoded derivative before allocating its bytes", async () => {
    const blob = new Blob([new Uint8Array(buildPng(32, 16))], { type: "image/png" });
    Object.defineProperty(blob, "size", { value: MEDIA_MAX_BYTES + 1 });
    const read = vi.spyOn(blob, "arrayBuffer"), deps = codecs();
    deps.encode = async () => blob;
    await expect(prepareMessagingPhoto(source(), {}, deps)).rejects.toThrow(/prepare/i);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an encoder's MIME mismatch even if its bytes resemble the requested PNG", async () => {
    const deps = codecs();
    deps.encode = async () => new Blob([new Uint8Array(buildPng(32, 16))], { type: "image/jpeg" });
    await expect(prepareMessagingPhoto(source(), {}, deps)).rejects.toThrow(/prepare/i);
  });

  it("releases a late decoded bitmap after chat preparation times out", async () => {
    const deps = codecs(), close = vi.fn();
    let release!: (value: Awaited<ReturnType<ImageDeps["decode"]>>) => void;
    deps.decode = () => new Promise((resolve) => { release = resolve; });
    await expect(prepareMessagingPhoto(source(), { timeoutMs: 10 }, deps)).rejects.toThrow(/prepare/i);
    release({ source: {} as CanvasImageSource, width: 32, height: 16, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("never returns an encode result after its selection is cancelled", async () => {
    const deps = codecs(), controller = new AbortController(), close = vi.fn();
    let entered!: () => void, release!: (value: Blob) => void;
    const encoding = new Promise<void>((resolve) => { entered = resolve; });
    deps.decode = async () => ({ source: {} as CanvasImageSource, width: 32, height: 16, close });
    deps.encode = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const pending = prepareMessagingPhoto(source(), { signal: controller.signal }, deps);
    await encoding;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
    release(new Blob([new Uint8Array(buildPng(32, 16))], { type: "image/png" }));
  });
});
