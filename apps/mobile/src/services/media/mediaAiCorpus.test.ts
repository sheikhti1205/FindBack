// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/applicationAi", () => ({
  getApplicationAi: () => ({
    android: true,
    manager: { statusOf: () => ({ checksumVerified: true }) },
  }),
}));

import {
  buildHeicFtyp,
  buildJpeg,
} from "./__fixtures__/synthetic";
import {
  importImage,
  type ImportDeps,
} from "./importImage";
import { sniffImage, probeDimensions } from "./importImage";

function fakeDeps(): ImportDeps {
  return {
    transcode: async () => new Uint8Array(512).fill(0xa5),
    webpEncodeSupported: true,
  };
}

describe("B1/B2 corpus: HEIC, 48MP-class, loop/echo", () => {
  it("sniffs HEIC bytes and resolves ispe extents without a full decode", async () => {
    const ftyp = buildHeicFtyp();
    expect(sniffImage(ftyp)).toBe("heic");
    // Generic probe is null for BMFF (metadata-only path), but the intake
    // must not pre-gate: it routes to a bounded JPEG derivative.
    expect(probeDimensions(ftyp, "heic")).toBeNull();
    const result = await importImage({ bytes: ftyp, fileName: "photo.heic" }, fakeDeps());
    expect(result.sniffed).toBe("heic");
    expect(result.derivative.mimeType).toBe("image/jpeg");
    expect(result.locationMetadataStripped).toBe(true);
  });

  it("downsamples 48MP-class dimensions instead of refusing (simulated header)", async () => {
    // 8000x6000 = 48 MP: header-only probe, sampled transcode target bounded.
    const bytes = buildJpeg(8000, 6000);
    expect(probeDimensions(bytes, "jpeg")).toEqual({ width: 8000, height: 6000 });
    let target: { targetWidth: number; targetHeight: number } | null = null;
    const result = await importImage(
      { bytes, fileName: "48mp.jpg", declaredMimeType: "image/jpeg" },
      {
        transcode: async (request) => {
          target = { targetWidth: request.targetWidth, targetHeight: request.targetHeight };
          return new Uint8Array(900_000).fill(1);
        },
        webpEncodeSupported: true,
      },
    );
    expect(target!.targetWidth).toBeLessThanOrEqual(1920);
    expect(target!.targetHeight).toBeLessThanOrEqual(1920);
    expect(result.derivative.width).toBeLessThanOrEqual(1920);
  });
});
