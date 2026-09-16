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

import { chooseFromGallery, isCancellation, photoToFile, takePhoto } from "./photo";

const photo = { type: 0, uri: "content://media/external/images/1", webPath: "http://localhost/_capacitor_file_/1.jpg", saved: false, metadata: { format: "jpg" } };

beforeEach(() => { camera.takePhoto.mockReset(); camera.chooseFromGallery.mockReset(); platform.native = true; });

describe("photo source", () => {
  it("keeps the native content:// URI and the webPath separate", async () => {
    camera.takePhoto.mockResolvedValue(photo);
    const picked = await takePhoto();
    expect(picked).toEqual({ nativeUri: "content://media/external/images/1", webPath: "http://localhost/_capacitor_file_/1.jpg", format: "jpg" });
    expect(picked!.nativeUri.startsWith("file://")).toBe(false);
  });

  it("falls back to webPath when the platform omits a native URI", async () => {
    camera.chooseFromGallery.mockResolvedValue({ results: [{ ...photo, uri: undefined }] });
    await expect(chooseFromGallery()).resolves.toMatchObject({ nativeUri: "http://localhost/_capacitor_file_/1.jpg" });
  });

  it("ignores video results and returns null when the user cancels", async () => {
    camera.chooseFromGallery.mockResolvedValue({ results: [{ ...photo, type: 1 }] });
    await expect(chooseFromGallery()).resolves.toBeNull();
    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(takePhoto()).resolves.toBeNull();
  });

  it("builds the upload File from webPath, never base64", async () => {
    const blob = new Blob(["bytes"], { type: "image/jpeg" });
    const fetchMock = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) });
    vi.stubGlobal("fetch", fetchMock);
    const file = await photoToFile({ nativeUri: "content://x", webPath: "http://localhost/x.jpg", format: "jpg" }, "x.jpg");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/x.jpg");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("x.jpg");
  });

  it("recognises the two cancellation codes", () => {
    expect(isCancellation({ code: "OS-PLUG-CAMR-0006" })).toBe(true);
    expect(isCancellation({ code: "OS-PLUG-CAMR-0020" })).toBe(true);
    expect(isCancellation(new Error("nope"))).toBe(false);
  });
});