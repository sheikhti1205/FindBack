import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildJpeg } from "./__fixtures__/synthetic";
const native = vi.hoisted(() => ({ chooseImage: vi.fn(), chooseImages: vi.fn(), importUri: vi.fn(), platform: "android" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => native.platform, isPluginAvailable: () => true }, registerPlugin: () => native }));
import { chooseNativeImage, chooseNativeImages, importNativeImageUri, importedImageToFile } from "./nativeMedia";

function result(overrides = {}) {
  return { derivativeBase64: btoa(String.fromCharCode(...buildJpeg(1442, 1920))), width: 1442, height: 1920, mimeType: "image/jpeg", sourceKind: "heic", originalByteLength: 20_000_000, motionStillUsed: false, videoBytesStripped: 0, sampledStill: false, locationMetadataStripped: true, orientation: 1, quality: 0.82, ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); native.platform = "android"; native.chooseImage.mockResolvedValue(result()); native.importUri.mockResolvedValue(result()); native.chooseImages.mockResolvedValue({ uris: [] }); });
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
  it("rejects before touching the bridge when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(importNativeImageUri("content://media/external/images/123", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(native.importUri).not.toHaveBeenCalled();
  });
  it("stops awaiting an in-flight import when the pick is cancelled", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    native.importUri.mockReturnValueOnce(gate);
    const controller = new AbortController();
    const pending = importNativeImageUri("content://media/external/images/123", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The orphaned bridge settlement stays observed by the race, so it never
    // surfaces as an unhandled rejection and is never committed.
    release(result());
    await expect(gate).resolves.toBeTruthy();
  });
});
describe("native multi-select intake (FBX-001)", () => {
  it("returns the ordered granted content URIs and never prepares them here", async () => {
    native.chooseImages.mockResolvedValue({ uris: ["content://media/external/images/1", "content://media/external/images/2"] });
    await expect(chooseNativeImages({ source: "photos", limit: 2 })).resolves.toEqual([
      "content://media/external/images/1",
      "content://media/external/images/2",
    ]);
    expect(native.chooseImages).toHaveBeenCalledWith({ source: "photos", limit: 2 });
    // Preparation stays a separate, per-URI step.
    expect(native.importUri).not.toHaveBeenCalled();
  });
  it("returns null on picker cancellation", async () => {
    native.chooseImages.mockResolvedValue({ cancelled: true });
    expect(await chooseNativeImages({ source: "photos", limit: 5 })).toBeNull();
  });
  it("drops non-string entries so a malformed plugin response cannot reach the importer", async () => {
    native.chooseImages.mockResolvedValue({ uris: ["content://media/a", 42 as unknown as string, null as unknown as string] });
    expect(await chooseNativeImages({ source: "files", limit: 3 })).toEqual(["content://media/a"]);
  });
  it("refuses multi-select on web instead of falling back to a File input", async () => {
    native.platform = "web";
    await expect(chooseNativeImages({ source: "photos", limit: 5 })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(native.chooseImages).not.toHaveBeenCalled();
  });
});
describe("importedImageToFile (FBX-001/030)", () => {
  it("turns a bounded derivative into a File with its mime type and bytes", async () => {
    native.importUri.mockResolvedValue(result());
    const imported = await importNativeImageUri("content://media/external/images/123");
    const file = importedImageToFile(imported);
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(imported.derivative.bytes.byteLength);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(imported.derivative.bytes);
  });
});
