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
import { generatedMotionPhoto } from "../__tests__/motionPhotoFixture";

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
  it("probes compatible ftyp brands, not just the major brand", () => {
    const bytes = new Uint8Array(24);
    new DataView(bytes.buffer).setUint32(0, 24);
    bytes.set(ascii("ftypmif1"), 4); bytes.set(ascii("heicavif"), 16);
    expect(sniffImage(bytes)).toBe("avif");
    bytes.set(ascii("heicisom"), 16);
    expect(sniffImage(bytes)).toBe("heic");
  });
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
  it("refuses a HEIF mpvd container before handing bytes to a decoder", async () => {
    const ftyp = buildHeicFtyp();
    const bytes = new Uint8Array(ftyp.length + 8);
    bytes.set(ftyp);
    new DataView(bytes.buffer).setUint32(ftyp.length, 8);
    bytes.set(ascii("mpvd"), ftyp.length + 4);
    const decoder = deps();
    await expect(importImage({ bytes, fileName: "motion.heic" }, decoder)).rejects.toThrow("still frame");
    expect(decoder.transcode).not.toHaveBeenCalled();
  });
  it("does not confuse a non-motion Ultra HDR directory with a malformed Motion Photo", async () => {
    const bytes = buildJpeg(48, 32);
    const hdr = new TextEncoder().encode('<Container:Directory><Container:Item Item:Semantic="GainMap"/></Container:Directory>');
    const segment = new Uint8Array(hdr.length + 4);
    segment.set([255, 225, 0, hdr.length + 2]); segment.set(hdr, 4);
    const mixed = new Uint8Array(bytes.length + segment.length);
    mixed.set(bytes.subarray(0, 2)); mixed.set(segment, 2); mixed.set(bytes.subarray(2), 2 + segment.length);
    const result = await importImage({ bytes: mixed, fileName: "hdr.jpg" }, deps());
    expect(result.motionStillUsed).toBe(false);
  });
  it("refuses an uncertain modern still instead of decoding a container via legacy metadata", async () => {
    const { bytes } = generatedMotionPhoto();
    const modern = new TextEncoder().encode('<Meta xmlns:Camera="http://ns.google.com/photos/1.0/camera/" Camera:MotionPhoto="1"/>');
    const segment = new Uint8Array(modern.length + 4);
    segment.set([255, 225, 0, modern.length + 2]); segment.set(modern, 4);
    const mixed = new Uint8Array(bytes.length + segment.length);
    mixed.set(bytes.subarray(0, 2)); mixed.set(segment, 2); mixed.set(bytes.subarray(2), 2 + segment.length);
    const transcode = fakeTranscode([512]);
    await expect(importImage({ bytes: mixed, fileName: "uncertain.jpg" }, deps({ transcode }))).rejects.toMatchObject({ code: "CORRUPT_IMAGE" });
    expect(transcode).not.toHaveBeenCalled();
  });
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
  it("uses big-endian EXIF orientation when calculating an oriented browser decode target", async () => {
    const bytes = buildJpeg(1200, 800, { orientation: 6 });
    bytes.set([77, 77, 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0], 12);
    const seen: TranscodeRequest[] = [];
    const result = await importImage({ bytes, fileName: "big-endian.jpg" }, deps({ transcode: fakeTranscode([512], seen) }));
    expect(result.exifOrientationApplied).toBe(6);
    expect(seen[0]).toMatchObject({ targetWidth: 800, targetHeight: 1200 });
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

  it("blocks pathological dimensions before any decode work", async () => {
    const transcode = fakeTranscode([16]);
    await expect(
      importImage(
        { bytes: buildPng(20_000, 20_000), fileName: "bomb.png", declaredMimeType: "image/png" },
        deps({ transcode }),
      ),
    ).rejects.toMatchObject({ code: "PIXEL_BOMB" });
    expect(transcode).not.toHaveBeenCalled();
  });

  it("downsamples an ordinary 32 MP phone photo instead of refusing it", async () => {
    const seen: TranscodeRequest[] = [];
    // The Xiaomi device case: 4928x6560 = 32.3 MP refused by the old 30 MP bound.
    const result = await importImage(
      { bytes: buildJpeg(4928, 6560), fileName: "1000026950.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([900_000], seen) }),
    );
    expect(result.motionStillUsed).toBe(false);
    expect(result.sampledStill).toBe(false);
    expect(result.derivative.width).toBe(1442);
    expect(result.derivative.height).toBe(1920);
    expect(seen[0]?.targetWidth).toBe(1442);
    expect(seen[0]?.targetHeight).toBe(1920);
  });

  it("extracts the Motion Photo still first and never decodes the video tail", async () => {
    const { bytes, stillEnd, video } = generatedMotionPhoto();
    const seen: TranscodeRequest[] = [];
    const result = await importImage(
      { bytes, fileName: "motion.jpg", declaredMimeType: "image/jpeg" },
      deps({ transcode: fakeTranscode([512], seen) }),
    );
    expect(result.motionStillUsed).toBe(true);
    expect(result.videoBytesStripped).toBe(bytes.length - stillEnd);
    expect(video.length).toBeGreaterThan(0);
    // The decoder input is the still alone, never the container.
    expect(seen[0]?.bytes.length).toBe(stillEnd);
    expect(result.originalByteLength).toBe(stillEnd);
  });

  it("samples an over-cap animation to a disclosed still instead of refusing it", async () => {
    // Valid animated PNG carrying one large tEXt chunk before IEND: the
    // passthrough stays over the 2 MB derivative bound, so intake samples a
    // still frame.
    const base = buildPng(64, 64, { animated: true });
    const payload = 2_100_000;
    const chunk = new Uint8Array(12 + payload);
    new DataView(chunk.buffer).setUint32(0, payload);
    chunk.set([0x74, 0x45, 0x58, 0x74], 4);
    const bytes = new Uint8Array(base.length + chunk.length);
    bytes.set(base.subarray(0, base.length - 12));
    bytes.set(chunk, base.length - 12);
    bytes.set(base.subarray(base.length - 12), base.length - 12 + chunk.length);
    const result = await importImage(
      { bytes, fileName: "long.png", declaredMimeType: "image/png" },
      deps({ transcode: fakeTranscode([900_000]) }),
    );
    expect(result.animated).toBe(false);
    expect(result.sampledStill).toBe(true);
    expect(result.derivative.mimeType).toBe("image/jpeg");
  });

  it("rejects inputs over the byte cap with an actionable message", async () => {
    const huge = new Uint8Array(101_000_000);
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

  it("accepts HEIC/AVIF via a bounded JPEG derivative; TIFF stays unsupported", async () => {
    for (const bytes of [buildAvifFtyp(), buildHeicFtyp()]) {
      const result = await importImage({ bytes, fileName: "photo.bin" }, deps());
      expect(result.derivative.mimeType).toBe("image/jpeg");
      expect(result.locationMetadataStripped).toBe(true);
    }
    await expect(importImage({ bytes: buildTiff(), fileName: "photo.tiff" }, deps())).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    try {
      await importImage({ bytes: buildTiff(), fileName: "photo.tiff" }, deps());
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/JPEG|PNG/i);
    }
  });

  it("normalizes an HEIC still with readable ispe extents to a bounded JPEG", async () => {
    // Minimal ftyp + ispe (800x1200): the header probe supplies dimensions so
    // the main ladder path normalizes instead of the unprobeable fallback.
    const ftyp = buildHeicFtyp();
    const ispe = new Uint8Array(20);
    ispe.set([0, 0, 0, 12, 105, 115, 112, 101, 0, 0, 0, 0, 0, 0, 3, 32, 0, 0, 4, 176]);
    const bytes = new Uint8Array(ftyp.length + ispe.length);
    bytes.set(ftyp);
    bytes.set(ispe, ftyp.length);
    const seen: TranscodeRequest[] = [];
    const result = await importImage(
      { bytes, fileName: "photo.heic", declaredMimeType: "image/heic" },
      deps({ transcode: fakeTranscode([512_000], seen) }),
    );
    expect(result.sniffed).toBe("heic");
    expect(result.derivative.mimeType).toBe("image/jpeg");
    expect(seen[0]?.targetWidth).toBeLessThanOrEqual(1920);
    expect(seen[0]?.targetHeight).toBeLessThanOrEqual(1920);
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
