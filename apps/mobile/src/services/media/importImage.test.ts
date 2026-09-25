import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_MAX_DERIVATIVE_BYTES,
  MediaError,
  importImage,
  probeDimensions,
  readExifOrientation,
  sniffImage,
  stripWebpExifChunk,
  type ImportDeps,
  type TranscodeRequest,
} from "./importImage";
import {
  ascii,
  buildAvifFtyp,
  buildBmp,
  buildGif,
  buildHeicFtyp,
  buildJpeg,
  buildPng,
  buildTiff,
  buildWebp,
} from "./__fixtures__/synthetic";

function fakeTranscode(sizes: number[], seen?: TranscodeRequest[]) {
  let call = 0;
  const transcode = vi.fn(async (request: TranscodeRequest): Promise<Uint8Array> => {
    seen?.push(request);
    const size = sizes[Math.min(call, sizes.length - 1)] ?? 1024;
    call += 1;
    const out = new Uint8Array(size);
    out.fill(0xa5);
    return out;
  });
  return transcode;
}

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return { transcode: fakeTranscode([1024]), webpEncodeSupported: true, ...overrides };
}

describe("sniffImage", () => {
  it("sniffs JPEG, PNG, GIF, WebP, and BMP from magic bytes", () => {
    expect(sniffImage(buildJpeg(8, 8))).toBe("jpeg");
    expect(sniffImage(buildPng(8, 8))).toBe("png");
    expect(sniffImage(buildGif(8, 8))).toBe("gif");
    expect(sniffImage(buildWebp(8, 8))).toBe("webp");
    expect(sniffImage(buildBmp(8, 8))).toBe("bmp");
  });

  it("distinguishes animated GIF/WebP/APNG from stills", () => {
    expect(sniffImage(buildGif(8, 8, { animated: true }))).toBe("gif-animated");
    expect(sniffImage(buildWebp(8, 8, { animated: true }))).toBe("webp-animated");
    expect(sniffImage(buildPng(8, 8, { animated: true }))).toBe("png-animated");
  });

  it("sniffs container-only formats the app cannot decode", () => {
    expect(sniffImage(buildAvifFtyp())).toBe("avif");
    expect(sniffImage(buildHeicFtyp())).toBe("heic");
    expect(sniffImage(buildTiff())).toBe("tiff");
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("probeDimensions / readExifOrientation", () => {
  it("reads stored dimensions from each supported header", () => {
    expect(probeDimensions(buildJpeg(1200, 800), "jpeg")).toEqual({ width: 1200, height: 800 });
    expect(probeDimensions(buildPng(100, 4000), "png")).toEqual({ width: 100, height: 4000 });
    expect(probeDimensions(buildGif(320, 200), "gif")).toEqual({ width: 320, height: 200 });
    expect(probeDimensions(buildWebp(640, 480), "webp")).toEqual({ width: 640, height: 480 });
    expect(probeDimensions(buildBmp(16, 16), "bmp")).toEqual({ width: 16, height: 16 });
  });

  it("reads the EXIF orientation tag and defaults to 1", () => {
    expect(readExifOrientation(buildJpeg(8, 8, { orientation: 6 }))).toBe(6);
    expect(readExifOrientation(buildJpeg(8, 8))).toBe(1);
    expect(readExifOrientation(buildPng(8, 8))).toBe(1);
  });

  it("returns null dimensions for truncated headers", () => {
    expect(probeDimensions(ascii("GIF89a"), "gif")).toBeNull();
    expect(probeDimensions(new Uint8Array([137, 80, 78, 71]), "png")).toBeNull();
  });
});

describe("importImage intake", () => {
  it("applies portrait EXIF orientation to the output dimensions", async () => {
    const seen: TranscodeRequest[] = [];
    // Stored landscape 1200x800 with orientation 6 -> portrait 800x1200.
    const bytes = buildJpeg(1200, 800, { orientation: 6 });
    const result = await importImage(
      { bytes, fileName: "portrait.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([512_000], seen) }),
    );
    expect(result.exifOrientationApplied).toBe(6);
    expect(result.derivative.width).toBe(800);
    expect(result.derivative.height).toBe(1200);
    expect(seen[0]?.targetWidth).toBe(800);
    expect(seen[0]?.targetHeight).toBe(1200);
  });

  it("keeps PNG alpha lossless", async () => {
    const seen: TranscodeRequest[] = [];
    const result = await importImage(
      { bytes: buildPng(64, 64, { colorType: 6 }), fileName: "alpha.png", declaredMimeType: "image/png" },
      deps({ transcode: fakeTranscode([2048], seen) }),
    );
    expect(result.derivative.mimeType).toBe("image/png");
    expect(result.derivative.quality).toBeNull();
    expect(seen[0]?.mimeType).toBe("image/png");
    expect(seen[0]?.quality).toBeNull();
  });

  it("rejects a declared MIME that mismatches the sniffed bytes", async () => {
    const bytes = buildJpeg(8, 8);
    await expect(
      importImage({ bytes, fileName: "photo.png", declaredMimeType: "image/png" }, deps()),
    ).rejects.toMatchObject({ code: "MIME_MISMATCH" });
    try {
      await importImage({ bytes, fileName: "photo.png", declaredMimeType: "image/png" }, deps());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaError);
      expect((error as Error).message).toMatch(/labeled image\/png/);
      expect((error as Error).message).toMatch(/look like jpeg/);
    }
  });

  it("accepts a generic declared type by trusting the sniffed bytes", async () => {
    const result = await importImage(
      { bytes: buildPng(8, 8), fileName: "blob", declaredMimeType: "application/octet-stream" },
      deps(),
    );
    expect(result.sniffed).toBe("png");
    expect(result.derivative.mimeType).toBe("image/png");
  });

  it("fails honestly on corrupt and unrecognized inputs", async () => {
    await expect(
      importImage({ bytes: ascii("definitely not a photo"), fileName: "x.bin" }, deps()),
    ).rejects.toMatchObject({ code: "UNRECOGNIZED_FORMAT" });
    await expect(
      importImage({ bytes: ascii("GIF89a"), fileName: "cut.gif", declaredMimeType: "image/gif" }, deps()),
    ).rejects.toMatchObject({ code: "CORRUPT_IMAGE" });
    await expect(
      importImage({ bytes: new Uint8Array(0), fileName: "empty.jpg" }, deps()),
    ).rejects.toMatchObject({ code: "EMPTY_INPUT" });
  });

  it("blocks pixel bombs before any decode work", async () => {
    const transcode = fakeTranscode([16]);
    await expect(
      importImage(
        { bytes: buildPng(20_000, 20_000), fileName: "bomb.png", declaredMimeType: "image/png" },
        deps({ transcode }),
      ),
    ).rejects.toMatchObject({ code: "PIXEL_BOMB" });
    expect(transcode).not.toHaveBeenCalled();
  });

  it("rejects inputs over the byte cap with an actionable message", async () => {
    const huge = new Uint8Array(17_000_000);
    huge.set([0xff, 0xd8, 0xff, 0xe0]);
    await expect(
      importImage({ bytes: huge, fileName: "huge.jpg" }, deps()),
    ).rejects.toMatchObject({ code: "OVERSIZED_INPUT" });
  });

  it("keeps an oversized-but-compressible input via the adaptive quality ladder", async () => {
    const seen: TranscodeRequest[] = [];
    const prefix = buildJpeg(4000, 3000);
    const bytes = new Uint8Array(12_000_000);
    bytes.set(prefix.subarray(0, Math.min(prefix.length, bytes.length)));
    const result = await importImage(
      { bytes, fileName: "big.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([4_000_000, 1_500_000], seen) }),
    );
    expect(result.derivative.byteLength).toBeLessThanOrEqual(IMPORT_MAX_DERIVATIVE_BYTES);
    expect(result.derivative.quality).toBe(0.7);
    expect(seen.length).toBe(2);
    expect(seen[0]?.quality).toBe(0.82);
  });

  it("fails when even the lowest quality stays over the derivative bound", async () => {
    await expect(
      importImage(
        { bytes: buildJpeg(4000, 3000), fileName: "big.jpg", declaredMimeType: "image/jpeg" },
        deps({ transcode: fakeTranscode([9_000_000, 8_000_000, 7_000_000, 6_000_000]) }),
      ),
    ).rejects.toMatchObject({ code: "DERIVATIVE_TOO_LARGE" });
  });

  it("strips GPS/EXIF from the JPEG derivative", async () => {
    const result = await importImage(
      {
        bytes: buildJpeg(32, 32, { orientation: 1, gps: true }),
        fileName: "geo.jpg",
        declaredMimeType: "image/jpeg",
      },
      deps({ transcode: fakeTranscode([512]) }),
    );
    expect(result.locationMetadataStripped).toBe(true);
    const text = new TextDecoder("latin1").decode(result.derivative.bytes);
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS");
  });

  it("strips the EXIF chunk from an animated WebP passthrough", async () => {
    const bytes = buildWebp(64, 64, { animated: true, exifGps: true });
    expect(new TextDecoder("latin1").decode(bytes)).toContain("GPS");
    const stripped = stripWebpExifChunk(bytes);
    expect(new TextDecoder("latin1").decode(stripped)).not.toContain("GPS");
    const result = await importImage(
      { bytes, fileName: "anim.webp", declaredMimeType: "image/webp" },
      deps(),
    );
    expect(result.animated).toBe(true);
    expect(result.locationMetadataStripped).toBe(true);
    expect(new TextDecoder("latin1").decode(result.derivative.bytes)).not.toContain("GPS");
  });

  it("drops the eXIf chunk from an animated PNG passthrough", async () => {
    const bytes = buildPng(64, 64, { animated: true, exIfGps: true });
    expect(new TextDecoder("latin1").decode(bytes)).toContain("GPS");
    const result = await importImage(
      { bytes, fileName: "anim.png", declaredMimeType: "image/png" },
      deps(),
    );
    expect(result.sniffed).toBe("png-animated");
    expect(result.animated).toBe(true);
    expect(result.locationMetadataStripped).toBe(true);
    expect(new TextDecoder("latin1").decode(result.derivative.bytes)).not.toContain("GPS");
  });

  it("passes animated GIFs through with the animation flag set", async () => {
    const result = await importImage(
      {
        bytes: buildGif(64, 64, { animated: true }),
        fileName: "anim.gif",
        declaredMimeType: "image/gif",
      },
      deps(),
    );
    expect(result.animated).toBe(true);
    expect(result.sniffed).toBe("gif-animated");
    expect(result.derivative.mimeType).toBe("image/gif");
  });

  it("marks still inputs as not animated", async () => {
    const still = await importImage(
      { bytes: buildWebp(64, 64), fileName: "still.webp", declaredMimeType: "image/webp" },
      deps(),
    );
    expect(still.animated).toBe(false);
    expect(still.sniffed).toBe("webp");
  });

  it("rejects AVIF/HEIC/TIFF with an actionable unsupported-format error", async () => {
    for (const bytes of [buildAvifFtyp(), buildHeicFtyp(), buildTiff()]) {
      await expect(importImage({ bytes, fileName: "photo.bin" }, deps())).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    }
    try {
      await importImage({ bytes: buildAvifFtyp(), fileName: "photo.avif" }, deps());
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/JPEG|PNG/i);
    }
  });

  it("re-encodes still GIF and BMP inputs to PNG derivatives", async () => {
    const gif = await importImage(
      { bytes: buildGif(32, 32), fileName: "still.gif", declaredMimeType: "image/gif" },
      deps(),
    );
    expect(gif.derivative.mimeType).toBe("image/png");
    const bmp = await importImage(
      { bytes: buildBmp(32, 32), fileName: "scan.bmp", declaredMimeType: "image/bmp" },
      deps(),
    );
    expect(bmp.derivative.mimeType).toBe("image/png");
  });

  it("preserves the user text verbatim and keeps the original reference", async () => {
    const text = "  hello 😊 <b>user text</b>  ";
    const result = await importImage(
      { bytes: buildPng(8, 8), fileName: "a.png", declaredMimeType: "image/png", text },
      deps(),
    );
    expect(result.text).toBe(text);
    expect(result.fileName).toBe("a.png");
    expect(result.originalByteLength).toBe(buildPng(8, 8).length);
    expect(result.id).toMatch(/^img_[A-Za-z0-9_-]+$/);
    expect(result.preview).toMatchObject({ mimeType: "image/png", animated: false });
  });

  it("does not mutate the caller's bytes", async () => {
    const bytes = buildPng(16, 16);
    const snapshot = bytes.slice();
    await importImage({ bytes, fileName: "a.png", declaredMimeType: "image/png" }, deps());
    expect(bytes).toEqual(snapshot);
  });

  it("downsamples beyond the max edge without enlarging small inputs", async () => {
    const seen: TranscodeRequest[] = [];
    const big = await importImage(
      { bytes: buildJpeg(4000, 2000), fileName: "big.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([1000], seen) }),
    );
    expect(seen[0]?.targetWidth).toBe(1920);
    expect(seen[0]?.targetHeight).toBe(960);
    expect(big.derivative.width).toBe(1920);
    const small = await importImage(
      { bytes: buildPng(40, 30), fileName: "small.png", declaredMimeType: "image/png" },
      deps({ transcode: fakeTranscode([100], seen) }),
    );
    expect(small.derivative.width).toBe(40);
    expect(small.derivative.height).toBe(30);
  });

  it("falls back to PNG when WebP encoding is unavailable", async () => {
    const seen: TranscodeRequest[] = [];
    const result = await importImage(
      { bytes: buildWebp(32, 32), fileName: "a.webp", declaredMimeType: "image/webp" },
      deps({ transcode: fakeTranscode([100], seen), webpEncodeSupported: false }),
    );
    expect(result.derivative.mimeType).toBe("image/png");
  });
});
