import { describe, expect, it } from "vitest";
import { detectMotionPhoto, strippedVideoBytes } from "../media/motionPhoto";
import { probeDimensions, sniffImage } from "../media/importImage";
import { generatedMotionPhoto } from "./motionPhotoFixture";

describe("generated Xiaomi/Google-style Motion Photo container (always in CI)", () => {
  it.each([0, 8, 32])("extracts a valid 16x16 JPEG with %i zero pad bytes", (padBytes) => {
    const fixture = generatedMotionPhoto(padBytes);
    const result = detectMotionPhoto(fixture.bytes);
    expect(result).toEqual({ stillEnd: fixture.stillEnd });
    const still = fixture.bytes.subarray(0, result!.stillEnd);
    expect(sniffImage(still)).toBe("jpeg");
    expect(probeDimensions(still, "jpeg")).toEqual({ width: 16, height: 16 });
    expect(Array.from(still.subarray(-2))).toEqual([0xff, 0xd9]);
    expect(strippedVideoBytes(fixture.bytes.length, result!.stillEnd)).toBe(padBytes + fixture.video.length);
    expect(fixture.bytes.subarray(fixture.mp4Start)).toEqual(fixture.video);
  });

  it("generates byte-identical independent fixtures with a complete MP4 box stream", () => {
    const a = generatedMotionPhoto();
    const b = generatedMotionPhoto();
    expect(a.bytes).toEqual(b.bytes);
    expect(a.bytes).not.toBe(b.bytes);
    const view = new DataView(a.video.buffer, a.video.byteOffset, a.video.byteLength);
    const boxes: string[] = [];
    let offset = 0;
    while (offset < a.video.length) {
      const size = view.getUint32(offset);
      expect(size).toBeGreaterThanOrEqual(8);
      expect(offset + size).toBeLessThanOrEqual(a.video.length);
      boxes.push(new TextDecoder().decode(a.video.subarray(offset + 4, offset + 8)));
      offset += size;
    }
    expect(offset).toBe(a.video.length);
    expect(boxes).toEqual(["ftyp", "moov", "moof", "mdat", "mfra"]);
  });

  it("rejects a truncated equivalent container instead of stripping an undeclared tail", () => {
    const { bytes } = generatedMotionPhoto();
    expect(detectMotionPhoto(bytes.subarray(0, bytes.length - 1))).toBeNull();
  });
});
