/**
 * H1-motion (c), option A: the High Quality Photo flag starts the import
 * pipeline's adaptive ladder at 0.92 while every cap stays hard.
 *
 * - Default input (flag absent/false) starts at 0.82 (legacy behavior).
 * - highQuality:true starts at 0.92, then steps DOWN through the standard
 *   rungs to fit the 2 MB derivative cap.
 * - Caps are untouched: oversized-but-compressible still resolves via the
 *   ladder; incompressible input still fails DERIVATIVE_TOO_LARGE.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_MAX_DERIVATIVE_BYTES,
  IMPORT_QUALITY_LADDER,
  IMPORT_QUALITY_LADDER_HQ,
  MediaError,
  importImage,
  type ImportDeps,
  type TranscodeRequest,
} from "./importImage";
import { buildJpeg } from "./__fixtures__/synthetic";

function fakeTranscode(sizes: number[], seen?: TranscodeRequest[]) {
  let call = 0;
  return vi.fn(async (request: TranscodeRequest): Promise<Uint8Array> => {
    seen?.push(request);
    const size = sizes[Math.min(call, sizes.length - 1)] ?? 1024;
    call += 1;
    const out = new Uint8Array(size);
    out.fill(0xa5);
    return out;
  });
}

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return { transcode: fakeTranscode([1024]), webpEncodeSupported: true, ...overrides };
}

describe("importImage highQuality ladder (H1-motion option A)", () => {
  it("keeps the standard ladder starting at 0.82 by default", () => {
    expect(IMPORT_QUALITY_LADDER[0]).toBe(0.82);
  });

  it("starts the HQ ladder at 0.92 and still contains every standard rung", () => {
    expect(IMPORT_QUALITY_LADDER_HQ[0]).toBe(0.92);
    for (const rung of IMPORT_QUALITY_LADDER) {
      expect(IMPORT_QUALITY_LADDER_HQ).toContain(rung);
    }
  });

  it("asks the encoder for 0.82 first when highQuality is absent", async () => {
    const seen: TranscodeRequest[] = [];
    const prefix = buildJpeg(800, 600);
    const bytes = new Uint8Array(200_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    const result = await importImage(
      { bytes, fileName: "std.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([500_000], seen) }),
    );
    expect(seen[0]?.quality).toBe(0.82);
    expect(result.derivative.quality).toBe(0.82);
  });

  it("asks the encoder for 0.92 first when highQuality is true", async () => {
    const seen: TranscodeRequest[] = [];
    const prefix = buildJpeg(800, 600);
    const bytes = new Uint8Array(200_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    const result = await importImage(
      { bytes, fileName: "hq.jpg", declaredMimeType: "image/jpeg", highQuality: true },
      deps({ transcode: fakeTranscode([500_000], seen) }),
    );
    expect(seen[0]?.quality).toBe(0.92);
    expect(result.derivative.quality).toBe(0.92);
    expect(result.derivative.byteLength).toBeLessThanOrEqual(IMPORT_MAX_DERIVATIVE_BYTES);
  });

  it("steps an HQ import DOWN the ladder to fit the derivative cap", async () => {
    const seen: TranscodeRequest[] = [];
    const prefix = buildJpeg(4000, 3000);
    const bytes = new Uint8Array(12_000_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    const result = await importImage(
      { bytes, fileName: "big-hq.jpg", declaredMimeType: "image/jpeg", highQuality: true },
      deps({ transcode: fakeTranscode([4_000_000, 3_000_000, 1_500_000], seen) }),
    );
    expect(seen.map((r) => r.quality)).toEqual([0.92, 0.82, 0.7]);
    expect(result.derivative.quality).toBe(0.7);
    expect(result.derivative.byteLength).toBeLessThanOrEqual(IMPORT_MAX_DERIVATIVE_BYTES);
  });

  it("still fails an HQ import that stays over the cap at the lowest rung", async () => {
    const prefix = buildJpeg(4000, 3000);
    const bytes = new Uint8Array(12_000_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    await expect(
      importImage(
        { bytes, fileName: "huge-hq.jpg", declaredMimeType: "image/jpeg", highQuality: true },
        deps({ transcode: fakeTranscode([9_000_000]) }),
      ),
    ).rejects.toMatchObject({ code: "DERIVATIVE_TOO_LARGE" });
  });

  it("treats highQuality:false exactly like the legacy default", async () => {
    const seen: TranscodeRequest[] = [];
    const prefix = buildJpeg(800, 600);
    const bytes = new Uint8Array(200_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    await importImage(
      { bytes, fileName: "std.jpg", declaredMimeType: "image/jpeg", highQuality: false },
      deps({ transcode: fakeTranscode([500_000], seen) }),
    );
    expect(seen[0]?.quality).toBe(0.82);
    expect(seen).toHaveLength(1);
  });

  it("keeps the failure type for HQ misuse identifiable", () => {
    expect(new MediaError("DERIVATIVE_TOO_LARGE", "x").code).toBe("DERIVATIVE_TOO_LARGE");
  });
});
