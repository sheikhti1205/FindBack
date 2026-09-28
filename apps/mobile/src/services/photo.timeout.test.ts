// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeImageMock = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@capacitor/camera", () => ({
  Camera: { takePhoto: vi.fn(), chooseFromGallery: vi.fn() },
  MediaType: { Photo: 0, Video: 1 },
  MediaTypeSelection: { Photo: 0, Video: 1, All: 2 },
  CameraErrorCode: { TakePhotoCancelled: "OS-PLUG-CAMR-0006", ChooseMediaCancelled: "OS-PLUG-CAMR-0020" },
}));

vi.mock("./image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image")>();
  return { ...actual, normalizeImage: normalizeImageMock };
});

import {
  MAX_ORIGINAL_BYTES,
  PhotoImportError,
  PhotoStageTimeoutError,
  normalizeForUpload,
  photoToFile,
  type PickedPhoto,
} from "./photo";

const SOF0_1X1 = [255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0];
const VALID_JPEG = new Uint8Array([255, 216, ...SOF0_1X1, 255, 217]);

function picked(webPath = "http://localhost/x.jpg"): PickedPhoto {
  return { nativeUri: "content://x", webPath, format: "jpg", id: "test-id" };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  normalizeImageMock.mockReset();
  // Default: no platform decoder; normalize falls back to verified originals.
  normalizeImageMock.mockRejectedValue(new Error("no decoder in this environment"));
});

describe("photo pipeline hardening (Lane C part 2)", () => {
  it("rejects an oversize Content-Length before materializing the blob", async () => {
    const blob = vi.fn(() => {
      throw new Error("blob() must not be called");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": String(MAX_ORIGINAL_BYTES + 1) }),
        blob,
      }),
    );
    await expect(photoToFile(picked())).rejects.toThrow("too large to process");
    expect(blob).not.toHaveBeenCalled();
    expect(normalizeImageMock).not.toHaveBeenCalled();
  });

  it("keeps the blob.size backstop when no Content-Length is present", async () => {
    const arrayBuffer = vi.fn(() => {
      throw new Error("bytes must not be read");
    });
    const huge = { size: MAX_ORIGINAL_BYTES + 1024, arrayBuffer } as unknown as Blob;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(huge) }));
    await expect(photoToFile(picked())).rejects.toThrow("too large to process");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(normalizeImageMock).not.toHaveBeenCalled();
  });

  it("maps a hung fetch stage to a typed PhotoStageTimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const err = await photoToFile(picked(), undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoStageTimeoutError);
    expect(err).toBeInstanceOf(PhotoImportError);
    expect((err as PhotoStageTimeoutError).stage).toBe("fetch");
  });

  it("maps a hung normalize stage to a typed PhotoStageTimeoutError", async () => {
    normalizeImageMock.mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([VALID_JPEG], { type: "image/jpeg" })),
      }),
    );
    const err = await photoToFile(picked(), "x.jpg", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoStageTimeoutError);
    expect((err as PhotoStageTimeoutError).stage).toBe("normalize");
  });

  it("does not call fetch when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(photoToFile(picked(), undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abort mid-decode stops work and skips encode (real normalizeImage)", async () => {
    const real = await vi.importActual<typeof import("./image")>("./image");
    const decode = vi.fn(() => new Promise<never>(() => undefined));
    const encode = vi.fn(async () => new Blob(["out"], { type: "image/jpeg" }));
    const controller = new AbortController();
    const pending = real.normalizeImage(
      new File([VALID_JPEG], "a.jpg", { type: "image/jpeg" }),
      { decode, encode, webpSupported: true },
      { signal: controller.signal, timeoutMs: 5000 },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(encode).not.toHaveBeenCalled();
  });

  it("propagates abort through normalizeForUpload instead of masking it", async () => {
    normalizeImageMock.mockImplementation(
      (_file: File, _deps?: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(opts.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = normalizeForUpload(new File([VALID_JPEG], "a.jpg", { type: "image/jpeg" }), {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("accounts the Motion Photo video tail separately and surfaces videoBytesStripped", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0]);
    const xmp = new TextEncoder().encode('GCamera:MicroVideo="1" GCamera:MicroVideoOffset="16"');
    const jpeg = new Uint8Array([255, 216, 255, 225, 0, xmp.length + 2, ...xmp, ...SOF0_1X1, 255, 217]);
    const combined = new Uint8Array(jpeg.length + mp4.length);
    combined.set(jpeg);
    combined.set(mp4, jpeg.length);
    normalizeImageMock.mockImplementation(async (source: File) => ({
      blob: source,
      mimeType: source.type,
      width: 1,
      height: 1,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([combined], { type: "image/jpeg" })),
      }),
    );
    const motion = picked("http://localhost/motion.jpg");
    const still = await photoToFile(motion);
    expect(motion.motionPhoto).toBe(true);
    // Only the still reaches the pipeline; the MP4 tail never does.
    expect(still.size).toBe(jpeg.length);
    expect(still.videoBytesStripped).toBe(mp4.length);
  });

  it("reports zero stripped bytes for an ordinary still", async () => {
    normalizeImageMock.mockImplementation(async (source: File) => ({
      blob: source,
      mimeType: source.type,
      width: 1,
      height: 1,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob([VALID_JPEG], { type: "image/jpeg" })),
      }),
    );
    const still = await photoToFile(picked());
    expect(still.videoBytesStripped).toBe(0);
  });

  it("uses HEIC ispe extents for a pre-decode downsample guard (real normalizeImage)", async () => {
    const real = await vi.importActual<typeof import("./image")>("./image");
    // Minimal BMFF head with an ispe box declaring 10000x5000 (50 MP > bound).
    const head = new Uint8Array(64);
    head.set([0x69, 0x73, 0x70, 0x65], 20); // "ispe"
    head.set([0, 0, 0x27, 0x10], 28); // width 10000 BE
    head.set([0, 0, 0x13, 0x88], 32); // height 5000 BE
    const decode = vi.fn(
      async (_file: File, opts?: { resizeWidth?: number; resizeHeight?: number }) => ({
        source: {} as CanvasImageSource,
        width: opts?.resizeWidth ?? 10000,
        height: opts?.resizeHeight ?? 5000,
      }),
    );
    const encode = vi.fn(async () => new Blob(["out"], { type: "image/jpeg" }));
    await real.normalizeImage(new File([head], "a.heic", { type: "image/heic" }), {
      decode,
      encode,
      webpSupported: true,
    });
    expect(decode).toHaveBeenCalledWith(
      expect.anything(),
      { resizeWidth: expect.any(Number), resizeHeight: expect.any(Number) },
    );
    expect(encode).toHaveBeenCalled();
  });
});
