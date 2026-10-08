// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({ takePhoto: vi.fn(), chooseFromGallery: vi.fn() }));
const platform = vi.hoisted(() => ({ native: true, os: "android" }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.os },
}));
vi.mock("@capacitor/camera", () => ({
  Camera: camera,
  MediaType: { Photo: 0, Video: 1 },
  MediaTypeSelection: { Photo: 0, Video: 1, All: 2 },
  CameraErrorCode: { TakePhotoCancelled: "OS-PLUG-CAMR-0006", ChooseMediaCancelled: "OS-PLUG-CAMR-0020" },
}));

// jsdom has no image decoder (createImageBitmap/canvas): the default mock
// rejects so photoToFile exercises its no-decoder fallback path. Individual
// tests override per-case to prove the normalize-first contract.
const normalizeImageMock = vi.hoisted(() => vi.fn());
vi.mock("./image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image")>();
  return { ...actual, normalizeImage: normalizeImageMock };
});

import { chooseFromGallery, isCancellation, normalizeForUpload, photoToFile, takePhoto } from "./photo";
import { DecodeError } from "./image";
import { detectMotionPhoto } from "./media/motionPhoto";

/** Minimal valid 1x1 JPEG header (SOI + SOF0 + EOI) for fallback probing. */
const SOF0_1X1 = [255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0];
const VALID_JPEG = new Uint8Array([255, 216, ...SOF0_1X1, 255, 217]);

const photo = { type: 0, uri: "content://media/external/images/1", webPath: "http://localhost/_capacitor_file_/1.jpg", saved: false, metadata: { format: "jpg" } };

beforeEach(() => {
  camera.takePhoto.mockReset();
  camera.chooseFromGallery.mockReset();
  platform.native = true;
  normalizeImageMock.mockReset();
  normalizeImageMock.mockRejectedValue(new Error("no decoder in this environment"));
});

describe("photo source", () => {
  it("keeps the native content:// URI and the webPath separate", async () => {
    camera.takePhoto.mockResolvedValue(photo);
    const picked = await takePhoto();
    expect(picked).toEqual({ nativeUri: "content://media/external/images/1", webPath: "http://localhost/_capacitor_file_/1.jpg", format: "jpg", id: picked!.id });
    expect(picked!.nativeUri.startsWith("file://")).toBe(false);
  });

  it("falls back to webPath when the platform omits a native URI", async () => {
    camera.chooseFromGallery.mockResolvedValue({ results: [{ ...photo, uri: undefined }] });
    await expect(chooseFromGallery()).resolves.toMatchObject({ nativeUri: "http://localhost/_capacitor_file_/1.jpg", id: expect.any(String) });
  });

  it("ignores video results and returns null when the user cancels", async () => {
    camera.chooseFromGallery.mockResolvedValue({ results: [{ ...photo, type: 1 }] });
    await expect(chooseFromGallery()).resolves.toBeNull();
    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(takePhoto()).resolves.toBeNull();
  });

  it("builds the upload File from webPath, never base64", async () => {
    const blob = new Blob([VALID_JPEG], { type: "image/jpeg" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
    vi.stubGlobal("fetch", fetchMock);
    const file = await photoToFile({ nativeUri: "content://x", webPath: "http://localhost/x.jpg", format: "jpg", id: "test-id" }, "x.jpg");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/x.jpg");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("x.jpg");
  });

  it("recognises the two cancellation codes", () => {
    expect(isCancellation({ code: "OS-PLUG-CAMR-0006" })).toBe(true);
    expect(isCancellation({ code: "OS-PLUG-CAMR-0020" })).toBe(true);
    expect(isCancellation(new Error("nope"))).toBe(false);
  });

  it("detects a motion clip from XMP plus its actual MP4 offset and keeps just the still", async () => {
    const mp4 = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0]);
    const xmp = new TextEncoder().encode(
      '<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="16"/>',
    );
    const jpeg = new Uint8Array([255, 216, 255, 225, 0, xmp.length + 2, ...xmp, ...SOF0_1X1, 255, 217]);
    const combined = new Uint8Array(jpeg.length + mp4.length);
    combined.set(jpeg); combined.set(mp4, jpeg.length);
    expect(detectMotionPhoto(combined)).toEqual({ stillEnd: jpeg.length });
    const picked = { nativeUri: "content://x", webPath: "http://localhost/motion.jpg", format: "jpg", id: "one", motionPhoto: false };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob([combined], { type: "image/jpeg" })) }));
    const still = await photoToFile(picked);
    expect(still.size).toBe(jpeg.length);
    expect(still.type).toBe("image/jpeg");
    expect(picked.motionPhoto).toBe(true);
  });

  it("normalizes a large original before enforcing the upload limit", async () => {
    // A 12 MB camera original that normalizes to a small derivative must be
    // accepted: the 8 MB limit applies to the RESULT, not the original.
    const original = new Uint8Array(12 * 1024 * 1024);
    original[0] = 255; original[1] = 216; original[2] = 255; original[3] = 224;
    const derivative = new Blob([new Uint8Array(900 * 1024)], { type: "image/jpeg" });
    normalizeImageMock.mockResolvedValueOnce({ blob: derivative, mimeType: "image/jpeg", width: 1920, height: 1280 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob([original], { type: "image/jpeg" })) }));
    const file = await photoToFile({ nativeUri: "content://x", webPath: "http://localhost/big.jpg", format: "jpg", id: "big" });
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(900 * 1024);
  });

  it("rejects the derivative when it still exceeds the upload limit", async () => {
    const original = new Uint8Array([255, 216, 255, 224, 0, 0]);
    normalizeImageMock.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 1920,
      height: 1280,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob([original], { type: "image/jpeg" })) }));
    await expect(photoToFile({ nativeUri: "content://x", webPath: "http://localhost/huge.jpg", format: "jpg", id: "huge" }))
      .rejects.toThrow("under 8 MB");
  });

  it("rejects originals above the decode safety bound without decoding", async () => {
    const original = new Uint8Array(49 * 1024 * 1024);
    original[0] = 255; original[1] = 216; original[2] = 255; original[3] = 224;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob([original], { type: "image/jpeg" })) }));
    await expect(photoToFile({ nativeUri: "content://x", webPath: "http://localhost/enormous.jpg", format: "jpg", id: "enormous" }))
      .rejects.toThrow("too large to process");
    expect(normalizeImageMock).not.toHaveBeenCalled();
  });

  it("does not infer motion from HEIC format or an unverified trailer", () => {
    const bytes = new TextEncoder().encode('GCamera:MicroVideoOffset="16" but not a JPEG');
    expect(detectMotionPhoto(bytes)).toBeNull();
  });

  it("rejects a huge native blob by size before reading bytes or decoding", async () => {
    // A 100 MB native image must die on its reported size: arrayBuffer must
    // never be called and the decoder must never run. The fake Blob carries
    // no allocation at all.
    const arrayBuffer = vi.fn(() => { throw new Error("bytes must not be read"); });
    const huge = { size: 100 * 1024 * 1024, arrayBuffer } as unknown as Blob;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(huge) }));
    await expect(photoToFile({ nativeUri: "content://x", webPath: "http://localhost/huge.jpg", format: "jpg", id: "huge" }))
      .rejects.toThrow("too large to process");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(normalizeImageMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized HEIC before calling the decoder", async () => {
    const arrayBuffer = vi.fn(() => { throw new Error("bytes must not be read"); });
    const hugeHeic = { size: 60 * 1024 * 1024, arrayBuffer } as unknown as Blob;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(hugeHeic) }));
    await expect(photoToFile({ nativeUri: "content://x", webPath: "http://localhost/big.heic", format: "heic", id: "heic-big" }))
      .rejects.toThrow("too large to process");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(normalizeImageMock).not.toHaveBeenCalled();
  });

  it("gives an actionable HEIC error when a small HEIC cannot be decoded", async () => {
    // ftyp box with a heic brand; decoder unavailable in this environment.
    const heic = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob([heic], { type: "image/heic" })) }));
    await expect(photoToFile({ nativeUri: "content://x", webPath: "http://localhost/a.heic", format: "heic", id: "heic-small" }))
      .rejects.toThrow("Export it as JPEG");
  });

  it("rejects renamed non-photos in the no-decoder fallback", async () => {
    const spoof = new File(["this is not image data at all"], "photo.jpg", { type: "image/jpeg" });
    await expect(normalizeForUpload(spoof)).rejects.toThrow("doesn't look like a photo file");
    expect(normalizeImageMock).toHaveBeenCalled();
  });

  it("rejects a declared JPEG whose bytes are really a PNG", async () => {
    // Minimal PNG: signature + IHDR with 1x1 dimensions + IEND.
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222,
      0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const mislabeled = new File([png], "photo.jpg", { type: "image/jpeg" });
    await expect(normalizeForUpload(mislabeled)).rejects.toThrow("claims to be image/jpeg");
  });

  it("rejects a JPEG with a damaged header in the no-decoder fallback", async () => {
    // SOI marker only: magic bytes claim JPEG but no SOF exists to verify.
    const truncated = new File([new Uint8Array([255, 216, 255, 217])], "photo.jpg", { type: "image/jpeg" });
    await expect(normalizeForUpload(truncated)).rejects.toThrow("header is damaged");
  });

  it("still accepts a verifiable image when no decoder exists", async () => {
    const valid = new File([VALID_JPEG], "photo.jpg", { type: "image/jpeg" });
    const out = await normalizeForUpload(valid);
    expect(out).toBe(valid);
  });

  it("refuses fallback when the available decoder attempted and rejected the file", async () => {
    // Valid headers but damaged pixel data: the decoder tried and said no.
    // Falling back to the original would only ship a corrupt file that fails
    // at publish time, so the failure stays a failure with guidance.
    normalizeImageMock.mockRejectedValueOnce(new DecodeError("rejected", "bad pixel data"));
    const damaged = new File([VALID_JPEG], "photo.jpg", { type: "image/jpeg" });
    await expect(normalizeForUpload(damaged)).rejects.toThrow("couldn't be decoded");
  });
});
