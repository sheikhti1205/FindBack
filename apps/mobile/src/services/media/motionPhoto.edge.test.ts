import { describe, expect, it } from "vitest";
import { detectMotionPhoto, detectMotionPhotoBounded } from "./motionPhoto";
import { PROBE_BYTES } from "./mediaPolicy";

/**
 * Edge-case coverage for detectMotionPhoto (motionPhoto.ts).
 *
 * All fixtures are synthetic minimal Motion Photo containers built in-test:
 * SOI + ASCII filler + XMP-style GCamera markers + EOI, an optional zero pad,
 * then a trailing box (size u32be + 4-byte type + payload). The declared
 * GCamera:MicroVideoOffset is the trailing-box length unless overridden.
 * No real user photo bytes are embedded here.
 */

const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function xmp(microVideo: string | null, offset: number | null): Uint8Array {
  const flag = microVideo === null ? "" : `GCamera:MicroVideo="${microVideo}" `;
  const off = offset === null ? "" : `GCamera:MicroVideoOffset="${offset}" `;
  return ascii(`<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" ${flag}${off}GCamera:MicroVideoVersion="1" />`);
}

/** size u32be + 4-byte type + 0xab payload (never 0xff, never "ftyp" by accident). */
function trailerBox(boxType: string, payloadLen: number): Uint8Array {
  const size = 4 + 4 + payloadLen;
  const out = new Uint8Array(size);
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  out.set(ascii(boxType), 4);
  out.fill(0xab, 8);
  return out;
}

interface FixtureOptions {
  padLen?: number;
  padFill?: number;
  mp4PayloadLen?: number;
  boxType?: string;
  microVideo?: string | null;
  /** "auto" declares the true trailer length; a number forces a value; null omits it. */
  declaredOffset?: number | "auto" | null;
  prefix?: Uint8Array;
  fillerLen?: number;
  includeEoi?: boolean;
}

interface Fixture {
  bytes: Uint8Array;
  /** Index just past the still EOI (expected stillEnd for valid containers). */
  stillEnd: number;
  /** Index where the trailing box starts (expected mp4Start for valid containers). */
  mp4Start: number;
}

function buildMotionPhoto(options: FixtureOptions = {}): Fixture {
  const {
    padLen = 0,
    padFill = 0,
    mp4PayloadLen = 32,
    boxType = "ftyp",
    microVideo = "1",
    declaredOffset = "auto",
    prefix = SOI,
    fillerLen = 64,
    includeEoi = true,
  } = options;
  const trailer = trailerBox(boxType, mp4PayloadLen);
  const declared = declaredOffset === "auto" ? trailer.length : declaredOffset;
  const header = concat(
    prefix,
    ascii("A".repeat(fillerLen)),
    xmp(microVideo, declared),
    ascii("B".repeat(16)),
    includeEoi ? EOI : new Uint8Array(0),
  );
  const pad = new Uint8Array(padLen).fill(padFill);
  return { bytes: concat(header, pad, trailer), stillEnd: header.length, mp4Start: header.length + padLen };
}

describe("detectMotionPhoto edge cases", () => {
  it("accepts a valid container with no padding and reports the exact still boundary", () => {
    const { bytes, stillEnd, mp4Start } = buildMotionPhoto();
    const result = detectMotionPhoto(bytes);
    expect(result).toEqual({ stillEnd });
    expect(mp4Start).toBe(stillEnd);
    const still = bytes.subarray(0, result!.stillEnd);
    expect(still[0]).toBe(0xff);
    expect(still[1]).toBe(0xd8);
    expect(still.at(-2)).toBe(0xff);
    expect(still.at(-1)).toBe(0xd9);
    const tail = bytes.subarray(result!.stillEnd);
    expect(String.fromCharCode(...tail.subarray(4, 8))).toBe("ftyp");
  });

  it("accepts a valid container with a short zero pad before the MP4 box", () => {
    const { bytes, stillEnd } = buildMotionPhoto({ padLen: 8 });
    const result = detectMotionPhoto(bytes);
    expect(result).toEqual({ stillEnd });
    expect(bytes.subarray(result!.stillEnd, result!.stillEnd + 8).every((b) => b === 0)).toBe(true);
  });

  it("rejects a tail truncated by a few bytes (declared offset no longer matches)", () => {
    const { bytes } = buildMotionPhoto();
    expect(detectMotionPhoto(bytes.subarray(0, bytes.length - 10))).toBeNull();
  });

  it("rejects a tail cut back to just past the still", () => {
    const { bytes, stillEnd } = buildMotionPhoto();
    expect(detectMotionPhoto(bytes.subarray(0, stillEnd + 8))).toBeNull();
  });

  it("rejects a trailing box without an ftyp type", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ boxType: "free" }).bytes)).toBeNull();
  });

  it("rejects a declared offset pointing past EOF", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ declaredOffset: 999_999 }).bytes)).toBeNull();
  });

  it("rejects non-JPEG bytes that still carry GCamera markers", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ prefix: PNG_MAGIC }).bytes)).toBeNull();
  });

  it("rejects zero-length input", () => {
    expect(detectMotionPhoto(new Uint8Array(0))).toBeNull();
  });

  it("rejects input shorter than the 32-byte minimum", () => {
    expect(detectMotionPhoto(concat(SOI, ascii("short")))).toBeNull();
  });

  it("rejects a header without the MicroVideo flag", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ microVideo: null }).bytes)).toBeNull();
  });

  it("rejects MicroVideo=\"0\"", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ microVideo: "0" }).bytes)).toBeNull();
  });

  it("rejects a header without a MicroVideoOffset", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ declaredOffset: null }).bytes)).toBeNull();
  });

  it("rejects a declared offset below the minimum box size", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ declaredOffset: 8 }).bytes)).toBeNull();
  });

  it("rejects non-zero padding between the still EOI and the MP4 box", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ padLen: 8, padFill: 0x01 }).bytes)).toBeNull();
  });

  it("rejects a container with no EOI before the MP4 box", () => {
    expect(detectMotionPhoto(buildMotionPhoto({ includeEoi: false }).bytes)).toBeNull();
  });
});

/**
 * FBX-002: the bounded-window detector must decide IDENTICALLY to the
 * whole-buffer one, from a header window plus two tiny targeted tail reads —
 * never from the still payload or the video tail.
 */
describe("bounded motion detection (FBX-002)", () => {
  async function bounded(bytes: Uint8Array) {
    const header = bytes.subarray(0, Math.min(bytes.length, PROBE_BYTES));
    const reads: Array<[number, number]> = [];
    const result = await detectMotionPhotoBounded(header, bytes.length, async (start, end) => {
      reads.push([start, end]);
      return bytes.subarray(start, Math.min(end, bytes.length));
    });
    return { result, reads };
  }

  it.each([
    {},
    { padLen: 8 },
    { padLen: 8, padFill: 0x01 },
    { boxType: "free" },
    { includeEoi: false },
    { declaredOffset: 999_999 },
    { declaredOffset: null },
    { prefix: PNG_MAGIC },
    { microVideo: "0" },
  ])("agrees with the whole-buffer detector and only reads tiny windows: %o", async (options) => {
    const { bytes, stillEnd } = buildMotionPhoto(options);
    const { result, reads } = await bounded(bytes);
    expect(result).toEqual(detectMotionPhoto(bytes));
    if (result !== null) expect(result.stillEnd).toBe(stillEnd);
    for (const [start, end] of reads) {
      expect(end - start).toBeLessThanOrEqual(34);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(bytes.length);
    }
  });

  it("decides a multi-megabyte Motion Photo from a few dozen bytes of tail", async () => {
    // A realistic container: XMP in the leading header (where every real
    // Motion Photo keeps it), a multi-MB JPEG still body, and a small MP4
    // tail. Detection must cost the header window plus two tiny tail reads —
    // never a proportional slice of the body.
    const trailer = trailerBox("ftyp", 4096);
    const still = concat(SOI, xmp("1", trailer.length), new Uint8Array(3 * 1024 * 1024).fill(0xcd), EOI);
    const bytes = concat(still, trailer);
    const stillEnd = still.length;
    expect(bytes.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(detectMotionPhoto(bytes)).toEqual({ stillEnd });
    const { result, reads } = await bounded(bytes);
    expect(result).toEqual({ stillEnd });
    const totalRead = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(totalRead).toBeLessThanOrEqual(34 * reads.length);
    expect(totalRead).toBeLessThan(bytes.length / 10_000);
  });
});
