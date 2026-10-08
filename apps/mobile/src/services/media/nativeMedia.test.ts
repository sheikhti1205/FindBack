import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildJpeg } from "./__fixtures__/synthetic";
const native = vi.hoisted(() => ({ chooseImage: vi.fn(), importUri: vi.fn(), platform: "android" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => native.platform, isPluginAvailable: () => true }, registerPlugin: () => native }));
import { chooseNativeImage, importNativeImageUri } from "./nativeMedia";

function result(overrides = {}) {
  return { derivativeBase64: btoa(String.fromCharCode(...buildJpeg(1442, 1920))), width: 1442, height: 1920, mimeType: "image/jpeg", sourceKind: "heic", originalByteLength: 20_000_000, motionStillUsed: false, videoBytesStripped: 0, sampledStill: false, locationMetadataStripped: true, orientation: 1, quality: 0.82, ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); native.platform = "android"; native.chooseImage.mockResolvedValue(result()); native.importUri.mockResolvedValue(result()); });
describe("native media intake seam", () => {
  it("chooses natively and exposes only bounded normalized pixels with original format metadata", async () => {
    const image = await chooseNativeImage({ source: "photos", highQuality: true, text: "keep text" });
    expect(native.chooseImage).toHaveBeenCalledWith({ source: "photos", highQuality: true });
    expect(image).toMatchObject({ sniffed: "heic", text: "keep text", animated: false, locationMetadataStripped: true, derivative: { width: 1442, height: 1920, mimeType: "image/jpeg" } });
    expect(image?.derivative.bytes).toEqual(buildJpeg(1442, 1920));
  });
  it("retains motion and sampled-still disclosures", async () => {
    native.chooseImage.mockResolvedValue(result({ motionStillUsed: true, videoBytesStripped: 1000, sampledStill: true }));
    expect(await chooseNativeImage({ source: "camera" })).toMatchObject({ motionStillUsed: true, videoBytesStripped: 1000, sampledStill: true });
  });
  it("returns null on picker cancellation", async () => {
    native.chooseImage.mockResolvedValue({ cancelled: true });
    expect(await chooseNativeImage({ source: "photos" })).toBeNull();
  });
  it.each([{ width: 32000 }, { width: 1441 }, { locationMetadataStripped: false }, { derivativeBase64: "not base64!" }])("rejects invalid native contracts %o", async (overrides) => {
    native.chooseImage.mockResolvedValue(result(overrides));
    await expect(chooseNativeImage({ source: "photos" })).rejects.toMatchObject({ code: "CORRUPT_IMAGE" });
  });
  it("does not let a raw file path or remote URI cross the bridge", async () => {
    await expect(importNativeImageUri("file:///private/photo.jpg")).rejects.toMatchObject({ code: "UNRECOGNIZED_FORMAT" });
    expect(native.importUri).not.toHaveBeenCalled();
    await importNativeImageUri("content://media/external/images/123");
    expect(native.importUri).toHaveBeenCalledWith({ uri: "content://media/external/images/123", highQuality: false });
  });
  it("refuses native calls on web, without falling back to reading original bytes", async () => {
    native.platform = "web";
    await expect(chooseNativeImage({ source: "photos" })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(native.chooseImage).not.toHaveBeenCalled();
  });
});
