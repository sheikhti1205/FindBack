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

export const IMPORT_MAX_INPUT_BYTES = 16_000_000;
export const IMPORT_MAX_DECODE_PIXELS = 30_000_000;
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

const UNSUPPORTED_KINDS: ReadonlySet<string> = new Set(["heic", "heif", "avif", "tiff"]);

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
  const brand = sliceAscii(bytes, 8, 4);
  if (brand === "avif" || brand === "avis") return "avif";
  if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") return "heic";
  if (brand === "heim" || brand === "heis" || brand === "hevm" || brand === "hevs") return "heic";
  if (brand === "mif1" || brand === "msf1") return "heif";
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
  if (tiff.length < 8 || sliceAscii(tiff, 0, 2) !== "II") return 1;
  const ifdOffset = readU32LE(tiff, 4);
  if (ifdOffset === null || ifdOffset + 2 > tiff.length) return 1;
  const count = readU16LE(tiff, ifdOffset);
  if (count === null) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    const tag = readU16LE(tiff, entry);
    const type = readU16LE(tiff, entry + 2);
    if (tag === 0x0112 && type === 3) {
      const value = readU16LE(tiff, entry + 8);
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
  const label =
    sniffed === "heic" || sniffed === "heif"
      ? "HEIC/HEIF"
      : sniffed === "avif"
        ? "AVIF"
        : "TIFF";
  return (
    `"${fileName}" looks like ${label}, which this app cannot decode here. ` +
    "Please pick a JPEG, PNG, WebP, GIF, or BMP version instead — nothing was imported."
  );
}

export async function importImage(input: ImportInput, deps: ImportDeps): Promise<ImportedImage> {
  const { bytes, fileName } = input;
  if (bytes.length === 0) {
    throw new MediaError("EMPTY_INPUT", `"${fileName}" is empty. Please pick a photo file and try again.`);
  }
  if (bytes.length > IMPORT_MAX_INPUT_BYTES) {
    const mb = (bytes.length / 1_000_000).toFixed(1);
    const cap = (IMPORT_MAX_INPUT_BYTES / 1_000_000).toFixed(0);
    throw new MediaError(
      "OVERSIZED_INPUT",
      `"${fileName}" is about ${mb} MB, over the ${cap} MB intake cap. ` +
        "Please pick a smaller file or trim it first — nothing was imported.",
    );
  }
  const sniffed = sniffImage(bytes);
  if (sniffed === null) {
    throw new MediaError(
      "UNRECOGNIZED_FORMAT",
      `"${fileName}" is not a recognized photo (JPEG, PNG, WebP, GIF, BMP). ` +
        "The file may be corrupt or a renamed non-photo — nothing was imported.",
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
  const probed = probeDimensions(bytes, sniffed);
  if (probed === null) {
    throw new MediaError(
      "CORRUPT_IMAGE",
      `"${fileName}" looks like ${baseKindOf(sniffed)} but its header is damaged or ` +
        "truncated, so dimensions cannot be read. Try re-saving the file — nothing was imported.",
    );
  }
  const pixels = probed.width * probed.height;
  if (pixels > IMPORT_MAX_DECODE_PIXELS) {
    throw new MediaError(
      "PIXEL_BOMB",
      `"${fileName}" declares ${probed.width}x${probed.height} pixels, over the ` +
        `${IMPORT_MAX_DECODE_PIXELS.toLocaleString("en-US")}-pixel decode bound. ` +
        "Decoding was refused to protect memory — nothing was imported.",
    );
  }
  const orientation = sniffed === "jpeg" ? readExifOrientation(bytes) : 1;
  const oriented =
    orientation >= 5
      ? { width: probed.height, height: probed.width }
      : { width: probed.width, height: probed.height };
  const target = fitWithin(IMPORT_MAX_EDGE, oriented.width, oriented.height);
  const animated =
    sniffed === "gif-animated" || sniffed === "webp-animated" || sniffed === "png-animated";

  let derivativeBytes: Uint8Array;
  let derivativeMime: string;
  let quality: number | null;
  if (animated) {
    derivativeMime =
      sniffed === "gif-animated" ? "image/gif" : sniffed === "webp-animated" ? "image/webp" : "image/png";
    derivativeBytes =
      sniffed === "webp-animated"
        ? stripWebpExifChunk(bytes)
        : sniffed === "png-animated"
          ? stripPngExIfChunk(bytes)
          : bytes.slice();
    quality = null;
    if (derivativeBytes.length > IMPORT_MAX_DERIVATIVE_BYTES) {
      throw new MediaError(
        "DERIVATIVE_TOO_LARGE",
        `"${fileName}" is animated and cannot be shrunk without losing animation, yet it ` +
          "is over the 2 MB derivative bound. Please pick a shorter or smaller animation.",
      );
    }
  } else {
    derivativeMime =
      sniffed === "jpeg"
        ? "image/jpeg"
        : sniffed === "png"
          ? "image/png"
          : sniffed === "webp" && deps.webpEncodeSupported
            ? "image/webp"
            : "image/png";
    const lossy = derivativeMime === "image/jpeg" || derivativeMime === "image/webp";
    if (lossy) {
      let picked: Uint8Array | null = null;
      let pickedQuality: number | null = null;
      const ladder = input.highQuality === true ? IMPORT_QUALITY_LADDER_HQ : IMPORT_QUALITY_LADDER;
      for (const candidate of ladder) {
        const encoded = await deps.transcode({
          bytes,
          sniffed,
          targetWidth: target.width,
          targetHeight: target.height,
          mimeType: derivativeMime,
          quality: candidate,
        });
        if (encoded.length <= IMPORT_MAX_DERIVATIVE_BYTES) {
          picked = encoded;
          pickedQuality = candidate;
          break;
        }
      }
      if (picked === null) {
        throw new MediaError(
          "DERIVATIVE_TOO_LARGE",
          `"${fileName}" stays over the 2 MB derivative bound even at the lowest quality. ` +
            "Please pick a smaller photo — nothing was imported.",
        );
      }
      derivativeBytes = picked;
      quality = pickedQuality;
    } else {
      derivativeBytes = await deps.transcode({
        bytes,
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

  const id = deps.createId ? deps.createId() : defaultId();
  const text = input.text ?? "";
  return {
    id,
    fileName,
    text,
    sniffed,
    declaredMimeType: declared,
    originalByteLength: bytes.length,
    animated,
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
