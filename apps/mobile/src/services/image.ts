/**
 * Client-side image normalization (Block 10H).
 *
 * Mirrors the Node sharp pipeline so a phone-camera file never consumes more
 * Storage than needed: honor EXIF orientation, cap the longest edge at 1920px
 * without enlarging for the upload/AI derivatives (source acceptance itself
 * has no megapixel cap — large dimensions downsample, never reject), and
 * re-encode by type (JPEG/WebP at the persisted photo quality tier — 82%
 * standard, 92% when the High Quality Photo flag is on; PNG lossless for
 * transparency; HEIC/HEIF/AVIF normalize to JPEG). Dimension/byte caps stay
 * hard regardless of tier. Animated GIFs are passed through untouched so
 * their animation survives. `createImageBitmap` is preferred; an `<img>`
 * fallback covers WebViews without it. The browser APIs are injectable so
 * the decision logic is unit testable without a real canvas. Sampling uses
 * decode-time resize so a 100 MB source never fully materializes in JS.
 */
import { BootTimeoutError, throwIfAborted, withTimeout } from "./timeout";
import { currentPhotoQuality } from "../appearance";
import {
  isAcceptedStillMime,
  MAX_EDGE as CANONICAL_MAX_EDGE,
  PROBE_BYTES,
} from "./media/mediaPolicy";

/**
 * Longest-edge downsample target for the bounded derivative — re-exported
 * from the single source-acceptance policy (L-CONSOLIDATE: mediaPolicy owns
 * the value, image.ts only aliases it so existing importers keep working).
 */
export const MAX_EDGE = CANONICAL_MAX_EDGE;
export const JPEG_QUALITY = 0.82;
export const WEBP_QUALITY = 0.82;
/**
 * Web decode working-set bound (L-CONSOLIDATE note: this is deliberately NOT
 * the import pipeline's IMPORT_MAX_DECODE_PIXELS pathological ceiling — the
 * old "mirroring" comment was stale drift (30M vs 120M). The web normalize
 * path decodes in a memory-constrained renderer/WebView, so over-bound
 * stills downsample AT DECODE TIME at this tighter bound; the byte
 * pipeline's pathological ceiling stays looser. The ordering invariant (web
 * bound never looser than the pathological ceiling) is pinned in
 * image.test.ts so the two can never cross silently.
 */
export const MAX_DECODE_PIXELS = 30_000_000;

/** Encode-quality tier (jpeg/webp) honoring the High Quality Photo flag. */
export interface PhotoQuality {
  readonly jpeg: number;
  readonly webp: number;
}

/**
 * Per-stage budget for decode/encode work. A hung platform decoder must fail
 * with an actionable error instead of stalling the report flow forever.
 */
export const IMAGE_STAGE_TIMEOUT_MS = 30_000;

export const DECODE_TOO_LARGE =
  "That photo's dimensions are too large to process safely on this device. Export a smaller version and try again.";

/**
 * Marks a decode failure as either a genuinely missing decoder
 * ("unavailable" — the environment cannot decode at all, so verified
 * original bytes may still be usable) or an attempted decode the decoder
 * refused ("rejected" — the bytes are damaged or in an undecodable variant,
 * so falling back to the original would only ship a corrupt file).
 */
export type DecodeFailureKind = "unavailable" | "rejected";

export class DecodeError extends Error {
  readonly kind: DecodeFailureKind;

  constructor(kind: DecodeFailureKind, message: string) {
    super(message);
    this.name = "DecodeError";
    this.kind = kind;
  }
}

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export interface NormalizedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

export interface DecodeOpts {
  /** Decode-time downsample target (honored where the platform supports it). */
  resizeWidth?: number;
  resizeHeight?: number;
}

export interface ImageDeps {
  decode(file: File, opts?: DecodeOpts): Promise<DecodedImage>;
  encode(
    source: CanvasImageSource,
    width: number,
    height: number,
    mimeType: string,
    quality: number | null,
  ): Promise<Blob>;
  webpSupported: boolean;
}

/** Scale to fit inside a square of `maxEdge`, never enlarging. */
export function fitWithin(
  maxEdge: number,
  width: number,
  height: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Output container/quality for a source MIME type. Defaults to the persisted
 * High Quality Photo tier so every normalizeImage caller honors the toggle
 * without threading the flag; pass an explicit tier to override (tests). */
export function outputTypeFor(
  mimeType: string,
  webpSupported: boolean,
  quality: PhotoQuality = currentPhotoQuality(),
): { mimeType: string; quality: number | null } {
  if (mimeType === "image/png") return { mimeType: "image/png", quality: null };
  if (mimeType === "image/webp") {
    return webpSupported
      ? { mimeType: "image/webp", quality: quality.webp }
      : { mimeType: "image/png", quality: null };
  }
  return { mimeType: "image/jpeg", quality: quality.jpeg };
}

export interface NormalizeOpts {
  /** Preserve GIFs by default. Still-only consumers opt into canvas re-encoding. */
  animation?: "preserve" | "still";
  /** Override for the decode pixel bound (default MAX_DECODE_PIXELS). */
  maxDecodePixels?: number;
  /** AbortSignal threaded from the photo pipeline; abort stops decode/encode. */
  signal?: AbortSignal;
  /** Per-stage budget in ms (default IMAGE_STAGE_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Encode-quality tier. Defaults to the persisted High Quality Photo tier
   * (`currentPhotoQuality()`); the HQ tier raises initial encode quality
   * only — MAX_EDGE / MAX_DECODE_PIXELS caps stay hard.
   */
  quality?: PhotoQuality;
}

export async function normalizeImage(
  file: File,
  deps: ImageDeps = browserDeps(),
  opts?: NormalizeOpts,
): Promise<NormalizedImage> {
  throwIfAborted(opts?.signal);
  if (!isAcceptedStillMime(file.type)) {
    throw new Error("Unsupported image type");
  }
  const maxPixels = opts?.maxDecodePixels ?? MAX_DECODE_PIXELS;
  const stageMs = opts?.timeoutMs ?? IMAGE_STAGE_TIMEOUT_MS;
  const signal = opts?.signal;
  // Inspect header dimensions BEFORE decoding: a few-MB file can describe
  // tens of megapixels. Over-bound stills are downsampled at decode time
  // (bounded memory, legitimate 50 MP photos accepted); over-bound GIFs
  // cannot be downsampled without losing animation, so they fail fast with
  // an actionable error instead of OOMing the renderer mid-decode.
  // Unprobeable kinds (HEIC/HEIF, truncated headers) first try the
  // HEIC ispe pre-decode guard below; anything still unknown decodes
  // without pre-scaling and relies on the post-decode bound.
  const probed = await probeFileDimensions(file, signal);
  throwIfAborted(signal);
  // Pre-decode guard for ISO-BMFF stills (HEIC/HEIF): the generic header
  // probe returns null for these kinds, but the meta/iprp/ispe box in the
  // leading slice carries the spatial extents. When present, over-bound
  // stills downsample at decode time exactly like probeable kinds.
  const heicGuard = !probed && (file.type === "image/heic" || file.type === "image/heif")
    ? await probeHeicExtents(file, signal)
    : null;
  throwIfAborted(signal);
  const effective = probed ?? heicGuard;
  const animated = file.type === "image/gif" && opts?.animation !== "still";
  if (effective && effective.width * effective.height > maxPixels) {
    if (animated) throw new DecodeError("rejected", DECODE_TOO_LARGE);
  }
  const downsample = effective && !animated && effective.width * effective.height > maxPixels
    ? scaleToPixels(effective.width, effective.height, maxPixels)
    : null;
  let decoded: DecodedImage;
  // Keep a handle on the decode promise, not just its result. A timeout or abort
  // rejects the race while the platform decoder keeps running; when it finally
  // resolves it hands back a closeable bitmap that no caller will ever see, and
  // the `finally` below cannot reach it because control already left this block.
  let decoding: Promise<DecodedImage> | undefined;
  try {
    const pending = downsample
      ? deps.decode(file, { resizeWidth: downsample.width, resizeHeight: downsample.height })
      : deps.decode(file);
    decoding = pending;
    decoded = await withTimeout(() => pending, stageMs, "Photo decode timed out", signal);
  } catch (err) {
    // Release a late arrival. `close()` is the owner's obligation and this
    // function is the only owner, so it must discharge it even after giving up.
    void decoding?.then(
      (late) => { try { late.close?.(); } catch { /* already released */ } },
      () => undefined,
    );
    // A decoder the platform actually attempted and refused means damaged or
    // undecodable bytes — mark it so callers do not fall back to shipping the
    // corrupt original. A genuinely missing decoder stays "unavailable".
    // Timeouts and aborts propagate untouched so the pipeline can type them.
    if (err instanceof DecodeError) throw err;
    if (err instanceof BootTimeoutError) throw err;
    if (signal?.aborted) throw signal.reason ?? err;
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new DecodeError("rejected", err instanceof Error ? err.message : "Could not decode the image");
  }
  try {
    throwIfAborted(signal);
    // Post-decode bound: platforms without decode-time resize still decode
    // full-size, and unprobeable kinds with no ispe metadata skip the
    // pre-decode guard — refuse the giant bitmap (releasing it first via the
    // finally below) instead of carrying hundreds of MB into canvas encode.
    if (decoded.width * decoded.height > maxPixels) {
      throw new DecodeError("rejected", DECODE_TOO_LARGE);
    }
    if (animated) {
      // Never round-trip an animation.
      return { blob: file, mimeType: "image/gif", width: decoded.width, height: decoded.height };
    }
    const { width, height } = fitWithin(MAX_EDGE, decoded.width, decoded.height);
    const output = outputTypeFor(
      // A sampled GIF uses PNG to retain transparency, not an unsupported GIF
      // encoder or a lossy JPEG with an implicit background color.
      file.type === "image/gif" ? "image/png" : file.type,
      deps.webpSupported,
      opts?.quality ?? currentPhotoQuality(),
    );
    const blob = await withTimeout(
      () => deps.encode(decoded.source, width, height, output.mimeType, output.quality),
      stageMs,
      "Photo encode timed out",
      signal,
    );
    return { blob, mimeType: output.mimeType, width, height };
  } finally {
    // Release is best-effort: a decoder whose `close()` throws must not replace
    // the result (or the error) this function is about to hand back, and the
    // late-arrival path above is guarded for the same reason.
    try { decoded.close?.(); } catch { /* already released */ }
  }
}

/** Largest dimensions within maxPixels preserving aspect ratio. */
function scaleToPixels(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const scale = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Header-only dimension probe: reads a small leading slice, never the whole
 * file. Returns null when the kind is unprobeable (HEIC/AVIF/TIFF) or the
 * header is truncated — callers then try the HEIC ispe guard and finally
 * enforce the post-decode bound instead.
 */
async function probeFileDimensions(
  file: File,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  try {
    throwIfAborted(signal);
    const head = file.slice(0, PROBE_BYTES);
    const buffer = typeof head.arrayBuffer === "function" ? await head.arrayBuffer() : null;
    throwIfAborted(signal);
    if (!buffer) return null;
    const bytes = new Uint8Array(buffer);
    const { sniffImage, probeDimensions } = await import("./media/importImage");
    const kind = sniffImage(bytes);
    if (!kind) return null;
    return probeDimensions(bytes, kind);
  } catch {
    return null;
  }
}

/**
 * Pre-decode dimension guard for ISO-BMFF stills (HEIC/HEIF) whose kinds the
 * generic header probe reports as unprobeable. Scans the leading 64 KB slice
 * for an `ispe` (image spatial extents) full-box and reads its declared
 * width/height — metadata only, never a decode. Returns null when no usable
 * extents exist, in which case the post-decode bound still applies.
 */
async function probeHeicExtents(
  file: File,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  try {
    throwIfAborted(signal);
    const head = file.slice(0, PROBE_BYTES);
    const buffer = typeof head.arrayBuffer === "function" ? await head.arrayBuffer() : null;
    throwIfAborted(signal);
    if (!buffer) return null;
    const found = readIspeExtents(new Uint8Array(buffer));
    return found;
  } catch {
    return null;
  }
}

/** Scan BMFF boxes for `ispe`: size(4) + "ispe"(4) + v/f(4) + w(4) + h(4). */
export function readIspeExtents(bytes: Uint8Array): { width: number; height: number } | null {
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

async function decodeImage(file: File, opts?: DecodeOpts): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      ...(opts?.resizeWidth && opts?.resizeHeight
        ? { resizeWidth: opts.resizeWidth, resizeHeight: opts.resizeHeight }
        : null),
    }).catch((err: unknown) => {
      throw new DecodeError("rejected", err instanceof Error ? err.message : "Could not decode the image");
    });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") {
    throw new DecodeError("unavailable", "Image decoding is not available in this environment");
  }
  return await new Promise<DecodedImage>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new DecodeError("rejected", "Could not read the image"));
    };
    image.src = url;
  });
}

async function encodeImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: string,
  quality: number | null,
): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process the image");
    ctx.drawImage(source, 0, 0, width, height);
    return await canvas.convertToBlob({ type: mimeType, quality: quality ?? undefined });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the image");
  ctx.drawImage(source, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
      mimeType,
      quality ?? undefined,
    );
  });
}

function webpEncodeSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

function browserDeps(): ImageDeps {
  return { decode: decodeImage, encode: encodeImage, webpSupported: webpEncodeSupported() };
}
