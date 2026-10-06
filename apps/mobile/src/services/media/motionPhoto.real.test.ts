import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectMotionPhoto } from "./motionPhoto";
import { probeDimensions, sniffImage } from "./importImage";

// The private user-supplied Xiaomi file is read locally; no image bytes enter git.
// MANUAL-ONLY suite: runs solely with FINDBACK_XIAOMI_PHOTO_PATH set on an
// owner machine. Normal CI skips it by design — the deterministic generated
// fixture (motionPhotoParser.test.ts) is the CI coverage, not this file.
const path = process.env.FINDBACK_XIAOMI_PHOTO_PATH;

describe.skipIf(!path)("MANUAL-ONLY supplied Xiaomi Motion Photo (optional owner validation)", () => {
  it("identifies the declared MP4 tail and returns a decodable JPEG still", () => {
    const bytes = readFileSync(path!);
    const result = detectMotionPhoto(bytes);
    expect(result).not.toBeNull();
    const still = bytes.subarray(0, result!.stillEnd);
    expect(sniffImage(still)).toBe("jpeg");
    expect(probeDimensions(still, "jpeg")).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(still.at(-2)).toBe(0xff);
    expect(still.at(-1)).toBe(0xd9);
    expect(still.length).toBeLessThan(8 * 1024 * 1024);
    expect(bytes.subarray(result!.stillEnd)).toContain(0x66); // MP4 ftyp header
  });
});
