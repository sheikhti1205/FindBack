import { describe, expect, it } from "vitest";
import { IMPORT_MAX_INPUT_BYTES } from "./importImage";
import { MAX_ORIGINAL_BYTES, PhotoImportError, SOURCE_LIMIT_MESSAGE, normalizeForUpload } from "../photo";
import { MAX_EDGE, MAX_DERIVATIVE_BYTES, PROBE_BYTES, SOURCE_MAX_BYTES, UPLOAD_MAX_BYTES, isWithinSourceCap } from "./mediaPolicy";

/**
 * FBX-004: ONE semantic source cap across the JS intake path and the Android
 * native processor (com.findback.app.media.MediaPolicy.MAX_SOURCE_BYTES).
 * 99 MiB reaches preparation; 100 MiB + 1 is refused before any decode or
 * source-sized allocation. Derivative caps are separate and never inherit
 * from the source cap. The JVM half of this contract is
 * MediaPolicyTest.sourceCapMatchesTheJsIntakePath.
 */
describe("media policy source cap", () => {
  it("is the single 100 MiB source bound shared by every intake path", () => {
    expect(SOURCE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ORIGINAL_BYTES).toBe(SOURCE_MAX_BYTES);
    expect(IMPORT_MAX_INPUT_BYTES).toBe(SOURCE_MAX_BYTES);
  });

  it("keeps derivative caps separate from the source cap", () => {
    expect(MAX_DERIVATIVE_BYTES).toBeLessThan(SOURCE_MAX_BYTES);
    expect(UPLOAD_MAX_BYTES).toBeLessThan(SOURCE_MAX_BYTES);
    expect(MAX_EDGE).toBe(1920);
    expect(PROBE_BYTES).toBe(65_536);
  });

  it("accepts 99 MiB and the cap itself, rejects one byte more", () => {
    // 99 MiB reaches preparation; the cap itself is still accepted.
    expect(isWithinSourceCap(99 * 1024 * 1024)).toBe(true);
    expect(isWithinSourceCap(SOURCE_MAX_BYTES)).toBe(true);
    expect(isWithinSourceCap(SOURCE_MAX_BYTES + 1)).toBe(false);
    expect(isWithinSourceCap(-1)).toBe(false);
    expect(isWithinSourceCap(Number.NaN)).toBe(false);
  });

  it("refuses an oversized source with the shared user-facing copy before decoding", async () => {
    const oversized = new File([new Uint8Array(0)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(oversized, "size", { value: SOURCE_MAX_BYTES + 1 });
    await expect(normalizeForUpload(oversized)).rejects.toBeInstanceOf(PhotoImportError);
    await expect(normalizeForUpload(oversized)).rejects.toThrow(SOURCE_LIMIT_MESSAGE);
    await expect(normalizeForUpload(oversized)).rejects.toThrow("100 MB");
  });

  it("lets a 99 MiB source reach preparation instead of the source-cap refusal", async () => {
    // 99 MiB is inside the cap: normalizeForUpload must NOT throw the
    // source-limit copy. The empty test payload may fail later decode/read
    // stages — any such error proves the source-cap gate was passed.
    const justUnder = new File([new Uint8Array(0)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(justUnder, "size", { value: 99 * 1024 * 1024 });
    const err = await normalizeForUpload(justUnder).then(() => null, (e: unknown) => e);
    expect(err === null || !(err instanceof Error && err.message === SOURCE_LIMIT_MESSAGE)).toBe(true);
  });
});
