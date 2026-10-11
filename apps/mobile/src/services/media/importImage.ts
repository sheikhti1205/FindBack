/**
 * Local image intake for chat selections and report photos.
 *
 * Pure and DOM-free: magic-byte sniffing, header dimension probing, EXIF
 * orientation, decode-memory guards, MIME-mismatch rejection, adaptive quality
 * selection, and location-metadata stripping all run on byte arrays. Pixel
 * work (downsample/re-encode) goes through the injected `transcode` seam, so
 * unit tests stay hermetic and the later report/chat wiring can supply a
 * browser implementation without changing this contract.
 *
 * Invariants: the transmitted derivative never carries EXIF/GPS location data;
 * the local original is kept only as a metadata reference; user text passes
 * through verbatim; ids are opaque references (never bytes).
 */

import { detectMotionPhoto, hasMotionPhotoMetadata, hasUnsupportedMotionContainer, strippedVideoBytes } from "./motionPhoto";
import { SOURCE_MAX_BYTES } from "./mediaPolicy";

/**
 * Downsample-first intake: ordinary modern camera media (32–50 MP, large
 * compressed files, Motion Photo containers, HEIC/HEIF/AVIF stills) is
 * normalized to a bounded derivative instead of being refused. Only
 * pathological inputs — absurd dimensions, impossible lengths, malformed
 * headers — are rejected. Source acceptance follows the single shared
 * SOURCE_MAX_BYTES cap when platform-readable; derivatives stay bounded
 * (preview/upload/AI are separate concerns).
 */
export const IMPORT_MAX_INPUT_BYTES = SOURCE_MAX_BYTES;
/**
 * Pathological decode ceiling (120 MP, 32k edge): ordinary 32–50 MP camera
 * photos pass through to downsampling; only absurd declarations refuse.
 * Never raise this to "fix" a normal photo — downsample instead.
 */
export const IMPORT_PATHOLOGICAL_PIXELS = 120_000_000;
export const IMPORT_PATHOLOGICAL_EDGE = 32_768;
/** Legacy alias: the old camera-refusing bound now means pathological-only. */
export const IMPORT_MAX_DECODE_PIXELS = IMPORT_PATHOLOGICAL_PIXELS;
export const IMPORT_MAX_EDGE = 1920;
export const IMPORT_MAX_DERIVATIVE_BYTES = 2_000_000;
export const IMPORT_QUALITY_LADDER: readonly number[] = [0.82, 0.7, 0.55, 0.4];
/**
 * H1-motion: first rung when the High Quality Photo flag is on. The ladder
 * still steps down through the standard rungs to fit the 2 MB derivative
 * cap, so byte/dimension caps stay hard — HQ only raises the initial
 * quality. Mirrors PHOTO_QUALITY_HIGH.jpeg in appearance.ts.
 */
export const IMPORT_QUALITY_LADDER_HQ: readonly number[] = [0.92, 0.82, 0.7, 0.55, 0.4];

export type MediaErrorCode =
  | "EMPTY_INPUT"
  | "OVERSIZED_INPUT"
  | "UNRECOGNIZED_FORMAT"
  | "MIME_MISMATCH"
  | "UNSUPPORTED_FORMAT"
  | "CORRUPT_IMAGE"
  | "PIXEL_BOMB"
  | "DERIVATIVE_TOO_LARGE";

export class MediaError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}

export type SniffedKind =
  | "jpeg"
  | "png"
  | "png-animated"
  | "gif"
  | "gif-animated"
  | "webp"
  | "webp-animated"
  | "bmp"
  | "heic"
  | "heif"
  | "avif"
  | "tiff";

export interface ImportInput {
  bytes: Uint8Array;
  fileName: string;
  declaredMimeType?: string;
  text?: string;
  /**
   * H1-motion: High Quality Photo flag. When true the adaptive lossy ladder
   * starts at 0.92 before stepping down to fit IMPORT_MAX_DERIVATIVE_BYTES;
   * caps stay hard either way. Defaults false (legacy behavior). The module
   * stays pure/DOM-free — callers read the persisted appearance flag and
   * pass it in (Help.tsx wiring is a follow-up; Help.tsx is frozen for H1).
   */
  highQuality?: boolean;
}

export interface TranscodeRequest {
  bytes: Uint8Array;
  sniffed: SniffedKind;
  targetWidth: number;
  targetHeight: number;
  mimeType: string;
  quality: number | null;
}

export interface ImportDeps {
  transcode: (request: TranscodeRequest) => Promise<Uint8Array>;
  webpEncodeSupported: boolean;
  createId?: () => string;
}

export interface ImportedImage {
  id: string;
  fileName: string;
  text: string;
  sniffed: SniffedKind;
  declaredMimeType: string;
  originalByteLength: number;
  animated: boolean;
  /** True when the source was a Motion Photo container and only the still frame was used. */
  motionStillUsed: boolean;
  /** Trailing container bytes (Motion Photo video tail) that never reached the decoder. */
  videoBytesStripped: number;
  /** True when an over-cap animation was sampled to a still frame with disclosure. */
  sampledStill: boolean;
  exifOrientationApplied: number;
  locationMetadataStripped: boolean;
  derivative: {
    bytes: Uint8Array;
    mimeType: string;
    byteLength: number;
    width: number;
    height: number;
    quality: number | null;
  };
  preview: {
    mimeType: string;
    width: number;
    height: number;
    byteLength: number;
    animated: boolean;
  };
}

const UNSUPPORTED_KINDS: ReadonlySet<string> = new Set(["tiff"]);

const DECLARED_TO_BASE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
  "image/x-tiff": "tiff",
};

const GENERIC_DECLARED: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function baseKindOf(sniffed: SniffedKind): string {
  if (sniffed === "png-animated") return "png";
  if (sniffed === "gif-animated") return "gif";
  if (sniffed === "webp-animated") return "webp";
  return sniffed;
}

function byteAt(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset >= bytes.length) return null;
  return bytes[offset] as number;
}

function sliceAscii(bytes: Uint8Array, offset: number, length: number): string | null {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const value = byteAt(bytes, offset + index);
    if (value === null) return null;
    out += String.fromCharCode(value);
  }
  return out;
}

function readU16BE(bytes: Uint8Array, offset: number): number | null {
  const high = byteAt(bytes, offset);
  const low = byteAt(bytes, offset + 1);
  if (high === null || low === null) return null;
  return (high << 8) | low;
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  const low = byteAt(bytes, offset);
  const high = byteAt(bytes, offset + 1);
  if (low === null || high === null) return null;
  return low | (high << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  const a = byteAt(bytes, offset);
  const b = byteAt(bytes, offset + 1);
  const c = byteAt(bytes, offset + 2);
  const d = byteAt(bytes, offset + 3);
  if (a === null || b === null || c === null || d === null) return null;
  return a * 0x1000000 + (b << 16) + (c << 8) + d;
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  const a = byteAt(bytes, offset);
  const b = byteAt(bytes, offset + 1);
  const c = byteAt(bytes, offset + 2);
  const d = byteAt(bytes, offset + 3);
  if (a === null || b === null || c === null || d === null) return null;
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

function readI32LE(bytes: Uint8Array, offset: number): number | null {
  const raw = readU32LE(bytes, offset);
  if (raw === null) return null;
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let match = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

interface WebpWalk {
  animated: boolean;
  width: number | null;
  height: number | null;
  hasExif: boolean;
  valid: boolean;
}

/** Walk RIFF/WEBP chunks: VP8X canvas size, ANMF animation, EXIF presence. */
function walkWebp(bytes: Uint8Array): WebpWalk {
  const result: WebpWalk = { animated: false, width: null, height: null, hasExif: false, valid: false };
  if (sliceAscii(bytes, 0, 4) !== "RIFF" || sliceAscii(bytes, 8, 4) !== "WEBP") return result;
  result.valid = true;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = sliceAscii(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    if (fourcc === null || size === null) return result;
    const dataStart = offset + 8;
    if (fourcc === "ANMF") result.animated = true;
    if (fourcc === "EXIF") result.hasExif = true;
    if (fourcc === "VP8X" && size >= 10) {
      const flags = byteAt(bytes, dataStart);
      const w0 = byteAt(bytes, dataStart + 4);
      const w1 = byteAt(bytes, dataStart + 5);
      const w2 = byteAt(bytes, dataStart + 6);
      const h0 = byteAt(bytes, dataStart + 7);
      const h1 = byteAt(bytes, dataStart + 8);
      const h2 = byteAt(bytes, dataStart + 9);
      if (flags !== null && (flags & 0x02) !== 0) result.animated = true;
      if (w0 !== null && w1 !== null && w2 !== null && h0 !== null && h1 !== null && h2 !== null) {
        result.width = (w0 | (w1 << 8) | (w2 << 16)) + 1;
        result.height = (h0 | (h1 << 8) | (h2 << 16)) + 1;
      }
    }
    offset = dataStart + size + (size % 2);
  }
  return result;
}

function sniffFtypBrand(bytes: Uint8Array): SniffedKind | null {
  if (bytes.length < 12 || sliceAscii(bytes, 4, 4) !== "ftyp") return null;
  const brands = [sliceAscii(bytes, 8, 4)];
  const end = Math.min(readU32BE(bytes, 0) ?? 0, bytes.length, 65536);
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(sliceAscii(bytes, offset, 4));
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return "avif";
  if (brands.some((brand) => brand !== null && ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(brand))) return "heic";
  if (brands.some((brand) => brand === "mif1" || brand === "msf1")) return "heif";
  return null;
}

export function sniffImage(bytes: Uint8Array): SniffedKind | null {
  if (bytes.length < 4) return null;
  const b0 = byteAt(bytes, 0);
  const b1 = byteAt(bytes, 1);
  const b2 = byteAt(bytes, 2);
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "jpeg";
  if (
    b0 === 137 &&
    b1 === 80 &&
    b2 === 78 &&
    byteAt(bytes, 3) === 71 &&
    sliceAscii(bytes, 4, 4) === "\r\n\u001a\n"
  ) {
    // Walk PNG chunk types (big-endian lengths); an acTL chunk marks APNG animation.
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const type = sliceAscii(bytes, offset + 4, 4);
      if (type === null) break;
      if (type === "acTL") return "png-animated";
      if (type === "IDAT" || type === "IEND") break;
      const length = readU32BE(bytes, offset);
      if (length === null || length > bytes.length) break;
      offset += 12 + length;
    }
    return "png";
  }
  const gifMagic = sliceAscii(bytes, 0, 6);
  if (gifMagic === "GIF87a" || gifMagic === "GIF89a") {
    const netscape = new Uint8Array([78, 69, 84, 83, 67, 65, 80, 69]);
    return containsBytes(bytes, netscape) ? "gif-animated" : "gif";
  }
  if (sliceAscii(bytes, 0, 4) === "RIFF" && sliceAscii(bytes, 8, 4) === "WEBP") {
    return walkWebp(bytes).animated ? "webp-animated" : "webp";
  }
  if (b0 === 0x42 && b1 === 0x4d) return "bmp";
  const tiffLE = sliceAscii(bytes, 0, 4);
  if (tiffLE === "II*\0" || tiffLE === "MM\0*") return "tiff";
  return sniffFtypBrand(bytes);
}

function probeJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) return null;
    let marker = byteAt(bytes, offset + 1);
    if (marker === null) return null;
    // Skip padding bytes.
    while (marker === 0xff && offset + 2 <= bytes.length) {
      offset += 1;
      marker = byteAt(bytes, offset + 1);
      if (marker === null) return null;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: entropy data follows; scan for the next marker.
      offset += 2;
      while (offset + 1 < bytes.length) {
        if (byteAt(bytes, offset) === 0xff && (byteAt(bytes, offset + 1) ?? 0) !== 0x00) break;
        offset += 1;
      }
      continue;
    }
    const length = readU16BE(bytes, offset + 2);
    if (length === null || length < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isSof) {
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      if (width === null || height === null || width <= 0 || height <= 0) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

export function probeDimensions(
  bytes: Uint8Array,
  sniffed: SniffedKind,
): { width: number; height: number } | null {
  switch (sniffed) {
    case "jpeg": {
      return probeJpegDimensions(bytes);
    }
    case "png":
    case "png-animated": {
      const width = readU32BE(bytes, 16);
      const height = readU32BE(bytes, 20);
      if (width === null || height === null || width <= 0 || height <= 0) return null;
      return { width, height };
    }
    case "gif":
    case "gif-animated": {
      const w0 = byteAt(bytes, 6);
      const w1 = byteAt(bytes, 7);
      const h0 = byteAt(bytes, 8);
      const h1 = byteAt(bytes, 9);
      if (w0 === null || w1 === null || h0 === null || h1 === null) return null;
      const width = w0 | (w1 << 8);
      const height = h0 | (h1 << 8);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    case "webp":
    case "webp-animated": {
      const walked = walkWebp(bytes);
      if (walked.width === null || walked.height === null) return null;
      return { width: walked.width, height: walked.height };
    }
    case "bmp": {
      const width = readI32LE(bytes, 18);
      const height = readI32LE(bytes, 22);
      if (width === null || height === null || width === 0 || height === 0) return null;
      return { width: Math.abs(width), height: Math.abs(height) };
    }
    default: {
      return null;
    }
  }
}

function readTiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const endian = sliceAscii(tiff, 0, 2);
  if (endian !== "II" && endian !== "MM") return 1;
  const read16 = endian === "II" ? readU16LE : readU16BE;
  const read32 = endian === "II" ? readU32LE : readU32BE;
  if (read16(tiff, 2) !== 42) return 1;
  const ifdOffset = read32(tiff, 4);
  if (ifdOffset === null || ifdOffset < 8 || ifdOffset + 2 > tiff.length) return 1;
  const count = read16(tiff, ifdOffset);
  if (count === null) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > tiff.length) return 1;
    const tag = read16(tiff, entry);
    const type = read16(tiff, entry + 2);
    if (tag === 0x0112 && type === 3 && read32(tiff, entry + 4) === 1) {
      const value = read16(tiff, entry + 8);
      if (value !== null && value >= 1 && value <= 8) return value;
      return 1;
    }
  }
  return 1;
}

/** EXIF orientation (1–8) from a JPEG APP1 segment; 1 when absent/unreadable. */
export function readExifOrientation(bytes: Uint8Array): number {
  let offset = 2;
  const exifMagic = new Uint8Array([69, 120, 105, 102, 0, 0]);
  while (offset + 4 <= bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) return 1;
    const marker = byteAt(bytes, offset + 1);
    const length = readU16BE(bytes, offset + 2);
    if (marker === null || length === null || length < 2) return 1;
    if (marker === 0xe1 && length >= 8) {
      let isExif = true;
      for (let index = 0; index < exifMagic.length; index += 1) {
        if (byteAt(bytes, offset + 4 + index) !== exifMagic[index]) {
          isExif = false;
          break;
        }
      }
      if (isExif) {
        return readTiffOrientation(bytes.slice(offset + 10, offset + 2 + length));
      }
    }
    if (marker === 0xda) return 1;
    offset += 2 + length;
  }
  return 1;
}

/** Rebuild a RIFF/WEBP container without EXIF chunks (location data removed). */
export function stripWebpExifChunk(bytes: Uint8Array): Uint8Array {
  if (sliceAscii(bytes, 0, 4) !== "RIFF" || sliceAscii(bytes, 8, 4) !== "WEBP") {
    return bytes.slice();
  }
  const kept: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = sliceAscii(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    if (fourcc === null || size === null) break;
    const dataStart = offset + 8;
    const padded = size + (size % 2);
    if (dataStart + padded > bytes.length) break;
    if (padded === 0) {
      // Zero-length chunk header (padding/garbage tail): carries no data, so
      // skip the header instead of queueing empty slices for the rebuild.
      offset = dataStart;
      continue;
    }
    if (fourcc !== "EXIF") {
      kept.push(bytes.slice(offset, dataStart + padded));
    }
    offset = dataStart + padded;
  }
  const body = kept.reduce(
    (acc, chunk) => {
      const merged = new Uint8Array(acc.length + chunk.length);
      merged.set(acc, 0);
      merged.set(chunk, acc.length);
      return merged;
    },
    new Uint8Array(4),
  );
  body.set([87, 69, 66, 80], 0);
  const out = new Uint8Array(8 + body.length);
  out.set([82, 73, 70, 70], 0);
  const riffSize = body.length;
  out.set(
    [riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, (riffSize >>> 24) & 0xff],
    4,
  );
  out.set(body, 8);
  return out;
}

/** Rebuild a PNG without eXIf chunks (location data removed, kept chunks verbatim). */
export function stripPngExIfChunk(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8) return bytes.slice();
  const kept: Uint8Array[] = [bytes.slice(0, 8)];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = sliceAscii(bytes, offset + 4, 4);
    if (length === null || type === null || length > bytes.length) break;
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    if (type !== "eXIf") {
      kept.push(bytes.slice(offset, end));
    }
    if (type === "IEND") break;
    offset = end;
  }
  const total = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function fitWithin(maxEdge: number, width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

let idCounter = 0;

function defaultId(): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `img_${Date.now().toString(36)}_${idCounter}_${random}`;
}

function unsupportedMessage(sniffed: SniffedKind, fileName: string): string {
  const label = "TIFF";
  return (
    `"${fileName}" looks like ${label}, which this app cannot decode here. ` +
    "Please pick a JPEG, PNG, WebP, GIF, HEIC, HEIF, AVIF, or BMP version instead — nothing was imported."
  );
}

/** Scan a leading slice for an ISO-BMFF `ispe` box (HEIC/HEIF/AVIF extents). Metadata only, never a decode. */
function readIspeExtents(bytes: Uint8Array): { width: number; height: number } | null {
  for (let i = 0; i + 16 <= bytes.length; i += 1) {
    if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
      const width = (bytes[i + 8]! * 0x1000000) + (bytes[i + 9]! << 16) + (bytes[i + 10]! << 8) + bytes[i + 11]!;
      const height = (bytes[i + 12]! * 0x1000000) + (bytes[i + 13]! << 16) + (bytes[i + 14]! << 8) + bytes[i + 15]!;
      if (
        Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && width > 0 && height > 0 && width <= 30000 && height <= 30000
      ) {
        return { width, height };
      }
      return null;
    }
  }
  return null;
}

/**
 * Unprobeable ISO-BMFF still (HEIC/HEIF/AVIF with no readable `ispe` in the
 * leading slice): never refuse up front. Attempt a bounded decode via the
 * injected transcode seam (sampled, oriented, EXIF-stripped by the platform)
 * and normalize to a JPEG derivative. A platform that can read the bytes
 * succeeds; one that cannot fails here with an actionable, retryable error
 * instead of a pre-gate rejection.
 */
async function importUnprobeableIsoBmff(
  input: ImportInput,
  deps: ImportDeps,
  ctx: {
    bytes: Uint8Array;
    still: Uint8Array;
    sniffed: SniffedKind;
    fileName: string;
    motionStillUsed: boolean;
    videoBytesStripped: number;
  },
): Promise<ImportedImage> {
  const { still, sniffed, fileName, motionStillUsed, videoBytesStripped } = ctx;
  const target = { width: IMPORT_MAX_EDGE, height: IMPORT_MAX_EDGE };
  const ladder = input.highQuality === true ? IMPORT_QUALITY_LADDER_HQ : IMPORT_QUALITY_LADDER;
  let picked: { bytes: Uint8Array; quality: number } | null = null;
  for (const candidate of ladder) {
    try {
      const encoded = await deps.transcode({
        bytes: still,
        sniffed,
        targetWidth: target.width,
        targetHeight: target.height,
        mimeType: "image/jpeg",
        quality: candidate,
      });
      if (encoded.length <= IMPORT_MAX_DERIVATIVE_BYTES) {
        picked = { bytes: encoded, quality: candidate };
        break;
      }
    } catch {
      throw new MediaError(
        "CORRUPT_IMAGE",
        `"${fileName}" could not be decoded on this device. Export it as JPEG and try again — nothing was imported.`,
      );
    }
  }
  if (picked === null) {
    throw new MediaError(
      "DERIVATIVE_TOO_LARGE",
      `"${fileName}" stays over the 2 MB derivative bound even at the lowest quality. ` +
        "Please pick a smaller photo — nothing was imported.",
    );
  }
  const id = deps.createId ? deps.createId() : defaultId();
  return {
    id,
    fileName,
    text: input.text ?? "",
    sniffed,
    declaredMimeType: (input.declaredMimeType ?? "").trim().toLowerCase(),
    originalByteLength: still.length,
    animated: false,
    motionStillUsed,
    videoBytesStripped,
    sampledStill: false,
    exifOrientationApplied: 1,
    locationMetadataStripped: true,
    derivative: {
      bytes: picked.bytes,
      mimeType: "image/jpeg",
      byteLength: picked.bytes.length,
      width: target.width,
      height: target.height,
      quality: picked.quality,
    },
    preview: {
      mimeType: "image/jpeg",
      width: target.width,
      height: target.height,
      byteLength: picked.bytes.length,
      animated: false,
    },
  };
}

export async function importImage(input: ImportInput, deps: ImportDeps): Promise<ImportedImage> {
  const { bytes, fileName } = input;
  if (bytes.length === 0) {
    throw new MediaError("EMPTY_INPUT", `"${fileName}" is empty. Please pick a photo file and try again.`);
  }
  const containerSniffed = sniffImage(bytes);
  if (hasUnsupportedMotionContainer(bytes)) {
    throw new MediaError("UNSUPPORTED_FORMAT", "Couldn't read the still frame of this HEIC/AVIF motion photo. Export a still JPEG and choose it again.");
  }
  if (containerSniffed === null) {
    throw new MediaError(
      "UNRECOGNIZED_FORMAT",
      `"${fileName}" is not a recognized photo (JPEG, PNG, WebP, GIF, BMP, HEIC, HEIF, AVIF). ` +
        "The file may be corrupt or a renamed non-photo — nothing was imported.",
    );
  }
  // Motion Photo: extract the still frame FIRST. The container's total size
  // (still + video tail) must never disqualify the useful still frame, and
  // the video tail never reaches the decoder or any provider.
  const motion = containerSniffed === "jpeg" ? detectMotionPhoto(bytes) : null;
  if (containerSniffed === "jpeg" && motion === null && hasMotionPhotoMetadata(bytes)) {
    throw new MediaError("CORRUPT_IMAGE", "Couldn't read the still frame of this motion photo. Try exporting a still JPEG instead.");
  }
  const motionStillUsed = motion !== null;
  const videoBytesStripped = strippedVideoBytes(bytes.length, motion?.stillEnd ?? null);
  const still = motionStillUsed ? bytes.subarray(0, motion.stillEnd) : bytes;
  if (still.length > IMPORT_MAX_INPUT_BYTES) {
    const mb = (still.length / 1_000_000).toFixed(1);
    // The cap is 100 MiB; advertise the rounded megabyte figure the user sees.
    const cap = (IMPORT_MAX_INPUT_BYTES / (1024 * 1024)).toFixed(0);
    throw new MediaError(
      "OVERSIZED_INPUT",
      `"${fileName}" is about ${mb} MB, over the ${cap} MB intake cap. ` +
        "Please pick a smaller file or trim it first — nothing was imported.",
    );
  }
  const sniffed = sniffImage(still);
  if (sniffed === null) {
    throw new MediaError(
      "CORRUPT_IMAGE",
      `"${fileName}" looks like a photo but its still frame cannot be read. ` +
        "Try re-saving the file — nothing was imported.",
    );
  }
  const declared = (input.declaredMimeType ?? "").trim().toLowerCase();
  if (!GENERIC_DECLARED.has(declared)) {
    const declaredBase = DECLARED_TO_BASE[declared];
    if (declaredBase !== undefined && declaredBase !== baseKindOf(sniffed)) {
      throw new MediaError(
        "MIME_MISMATCH",
        `"${fileName}" is labeled ${declared} but its bytes look like ${baseKindOf(sniffed)}. ` +
          "The type was not trusted; rename or re-save the file and try again.",
      );
    }
  }
  if (UNSUPPORTED_KINDS.has(sniffed)) {
    throw new MediaError("UNSUPPORTED_FORMAT", unsupportedMessage(sniffed, fileName));
  }
  // Header probe first (sampled, never full decode). ISO-BMFF stills
  // (HEIC/HEIF/AVIF) report null from the generic probe; the `ispe` extents
  // box carries their dimensions — metadata only, never a decode.
  const genericProbed = probeDimensions(still, sniffed);
  const ispeProbed =
    genericProbed === null && (sniffed === "heic" || sniffed === "heif" || sniffed === "avif")
      ? readIspeExtents(still.subarray(0, Math.min(still.length, 65536)))
      : null;
  const probed = genericProbed ?? ispeProbed;
  if (probed === null) {
    // HEIC/HEIF/AVIF without readable extents still deserve a decode attempt:
    // the platform decoder (native) may read what the header probe cannot.
    // Route them to the transcode seam with a bounded target instead of
    // refusing up front; only truly header-damaged probeable kinds fail here.
    if (sniffed === "heic" || sniffed === "heif" || sniffed === "avif") {
      return importUnprobeableIsoBmff(input, deps, {
        bytes,
        still,
        sniffed,
        fileName,
        motionStillUsed,
        videoBytesStripped,
      });
    }
    throw new MediaError(
      "CORRUPT_IMAGE",
      `"${fileName}" looks like ${baseKindOf(sniffed)} but its header is damaged or ` +
        "truncated, so dimensions cannot be read. Try re-saving the file — nothing was imported.",
    );
  }
  // Pathological ceiling only: ordinary large camera photos fall through to
  // downsampling below instead of refusing. Never raise this to admit a
  // normal photo — the transcode target already bounds the decode.
  const pixels = probed.width * probed.height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > IMPORT_PATHOLOGICAL_PIXELS ||
    probed.width > IMPORT_PATHOLOGICAL_EDGE ||
    probed.height > IMPORT_PATHOLOGICAL_EDGE ||
    probed.width <= 0 ||
    probed.height <= 0
  ) {
    throw new MediaError(
      "PIXEL_BOMB",
      `"${fileName}" declares ${probed.width}x${probed.height} pixels, which looks invalid. ` +
        "Decoding was refused to protect memory — nothing was imported.",
    );
  }
  const orientation = sniffed === "jpeg" ? readExifOrientation(still) : 1;
  const oriented =
    orientation >= 5
      ? { width: probed.height, height: probed.width }
      : { width: probed.width, height: probed.height };
  const target = fitWithin(IMPORT_MAX_EDGE, oriented.width, oriented.height);
  const animatedSource =
    sniffed === "gif-animated" || sniffed === "webp-animated" || sniffed === "png-animated";
  const animatedMime =
    sniffed === "gif-animated" ? "image/gif" : sniffed === "webp-animated" ? "image/webp" : "image/png";

  let derivativeBytes: Uint8Array;
  let derivativeMime: string;
  let quality: number | null;
  let animated = animatedSource;
  let sampledStill = false;
  if (animatedSource) {
    const passthrough =
      sniffed === "webp-animated"
        ? stripWebpExifChunk(still)
        : sniffed === "png-animated"
          ? stripPngExIfChunk(still)
          : still.slice();
    if (passthrough.length <= IMPORT_MAX_DERIVATIVE_BYTES) {
      derivativeMime = animatedMime;
      derivativeBytes = passthrough;
      quality = null;
    } else {
      // Over-cap animation: sample a still frame with disclosure instead of
      // refusing. The decoder reads the first frame; the animation stays out
      // of the derivative while storage keeps the caller's context.
      const ladder = input.highQuality === true ? IMPORT_QUALITY_LADDER_HQ : IMPORT_QUALITY_LADDER;
      derivativeMime = "image/jpeg";
      const sampled = await transcodeLadder(still, sniffed, target, derivativeMime, ladder);
      if (sampled === null) {
        throw new MediaError(
          "DERIVATIVE_TOO_LARGE",
          `"${fileName}" is animated and cannot be shrunk without losing animation, yet it ` +
            "is over the 2 MB derivative bound. Please pick a shorter or smaller animation.",
        );
      }
      derivativeBytes = sampled.bytes;
      quality = sampled.quality;
      animated = false;
      sampledStill = true;
    }
  } else {
    if (sniffed === "heic" || sniffed === "heif" || sniffed === "avif") {
      // Platform-decodable BMFF still with readable extents: normalize to a
      // bounded JPEG derivative (orientation applied, location stripped).
      const ladder = input.highQuality === true ? IMPORT_QUALITY_LADDER_HQ : IMPORT_QUALITY_LADDER;
      derivativeMime = "image/jpeg";
      const picked = await transcodeLadder(still, sniffed, target, derivativeMime, ladder);
      if (picked === null) {
        throw new MediaError(
          "DERIVATIVE_TOO_LARGE",
          `"${fileName}" stays over the 2 MB derivative bound even at the lowest quality. ` +
            "Please pick a smaller photo — nothing was imported.",
        );
      }
      derivativeBytes = picked.bytes;
      quality = picked.quality;
    } else {
    derivativeMime =
      sniffed === "jpeg"
        ? "image/jpeg"
        : sniffed === "png"
          ? "image/png"
          : sniffed === "webp" && deps.webpEncodeSupported
            ? "image/webp"
            : sniffed === "webp"
              ? "image/png"
          : sniffed === "bmp" || sniffed === "gif"
            ? "image/png"
            : "image/png";
    const lossy = derivativeMime === "image/jpeg" || derivativeMime === "image/webp";
    if (lossy) {
      const ladder = input.highQuality === true ? IMPORT_QUALITY_LADDER_HQ : IMPORT_QUALITY_LADDER;
      const picked = await transcodeLadder(still, sniffed, target, derivativeMime, ladder);
      if (picked === null) {
        throw new MediaError(
          "DERIVATIVE_TOO_LARGE",
          `"${fileName}" stays over the 2 MB derivative bound even at the lowest quality. ` +
            "Please pick a smaller photo — nothing was imported.",
        );
      }
      derivativeBytes = picked.bytes;
      quality = picked.quality;
    } else {
      derivativeBytes = await deps.transcode({
        bytes: still,
        sniffed,
        targetWidth: target.width,
        targetHeight: target.height,
        mimeType: derivativeMime,
        quality: null,
      });
      quality = null;
      if (derivativeBytes.length > IMPORT_MAX_DERIVATIVE_BYTES) {
        throw new MediaError(
          "DERIVATIVE_TOO_LARGE",
          `"${fileName}" stays over the 2 MB derivative bound as lossless PNG. ` +
            "Please pick a JPEG still instead — nothing was imported.",
        );
      }
    }
    }
  }

  async function transcodeLadder(
    source: Uint8Array,
    sourceSniffed: SniffedKind,
    size: { width: number; height: number },
    mime: string,
    ladder: readonly number[],
  ): Promise<{ bytes: Uint8Array; quality: number } | null> {
    for (const candidate of ladder) {
      const encoded = await deps.transcode({
        bytes: source,
        sniffed: sourceSniffed,
        targetWidth: size.width,
        targetHeight: size.height,
        mimeType: mime,
        quality: candidate,
      });
      if (encoded.length <= IMPORT_MAX_DERIVATIVE_BYTES) {
        return { bytes: encoded, quality: candidate };
      }
    }
    return null;
  }

  const id = deps.createId ? deps.createId() : defaultId();
  const text = input.text ?? "";
  return {
    id,
    fileName,
    text,
    sniffed,
    declaredMimeType: declared,
    originalByteLength: still.length,
    animated,
    motionStillUsed,
    videoBytesStripped,
    sampledStill,
    exifOrientationApplied: orientation,
    locationMetadataStripped: true,
    derivative: {
      bytes: derivativeBytes,
      mimeType: derivativeMime,
      byteLength: derivativeBytes.length,
      width: target.width,
      height: target.height,
      quality,
    },
    preview: {
      mimeType: derivativeMime,
      width: target.width,
      height: target.height,
      byteLength: derivativeBytes.length,
      animated,
    },
  };
}
