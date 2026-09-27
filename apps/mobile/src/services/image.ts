/**
 * Client-side image normalization (Block 10H).
 *
 * Mirrors the Node sharp pipeline so a phone-camera file never consumes more
 * Storage than needed: honor EXIF orientation, cap the longest edge at 1920px
 * without enlarging, and re-encode by type (JPEG/WebP at 82%, PNG lossless for
 * transparency). Animated GIFs are passed through untouched so their animation
 * survives. `createImageBitmap` is preferred; an `<img>` fallback covers WebViews
 * without it. The browser APIs are injectable so the decision logic is unit
 * testable without a real canvas.
 */
export const MAX_EDGE = 1920;
export const JPEG_QUALITY = 0.82;
export const WEBP_QUALITY = 0.82;
/**
 * Decode pixel bound, mirroring the import pipeline's IMPORT_MAX_DECODE_PIXELS.
 * A small compressed file can still describe enormous dimensions; decoding it
 * at full resolution would OOM the renderer. Images over the bound are
 * downsampled AT DECODE TIME (createImageBitmap resize) — never rejected for
 * being high-resolution — with an actionable error only where the device
 * cannot downsample safely.
 */
export const MAX_DECODE_PIXELS = 30_000_000;

export const DECODE_TOO_LARGE =
  "That photo's dimensions are too large to process safely on this device. Export a smaller version and try again.";

const ALLOWED_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

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

/** Output container/quality for a source MIME type. */
export function outputTypeFor(
  mimeType: string,
  webpSupported: boolean,
): { mimeType: string; quality: number | null } {
  if (mimeType === "image/png") return { mimeType: "image/png", quality: null };
  if (mimeType === "image/webp") {
    return webpSupported
      ? { mimeType: "image/webp", quality: WEBP_QUALITY }
      : { mimeType: "image/png", quality: null };
  }
  return { mimeType: "image/jpeg", quality: JPEG_QUALITY };
}

export interface NormalizeOpts {
  /** Override for the decode pixel bound (default MAX_DECODE_PIXELS). */
  maxDecodePixels?: number;
}

export async function normalizeImage(
  file: File,
  deps: ImageDeps = browserDeps(),
  opts?: NormalizeOpts,
): Promise<NormalizedImage> {
  if (!ALLOWED_MIME.includes(file.type)) {
    throw new Error("Unsupported image type");
  }
  const maxPixels = opts?.maxDecodePixels ?? MAX_DECODE_PIXELS;
  // Inspect header dimensions BEFORE decoding: a few-MB file can describe
  // tens of megapixels. Over-bound stills are downsampled at decode time
  // (bounded memory, legitimate 50 MP photos accepted); over-bound GIFs
  // cannot be downsampled without losing animation, so they fail fast with
  // an actionable error instead of OOMing the renderer mid-decode.
  // Unprobeable kinds (HEIC, truncated headers) skip pre-scaling and rely on
  // the post-decode bound below.
  const probed = await probeFileDimensions(file);
  const animated = file.type === "image/gif";
  if (probed && probed.width * probed.height > maxPixels) {
    if (animated) throw new DecodeError("rejected", DECODE_TOO_LARGE);
  }
  const downsample = probed && !animated && probed.width * probed.height > maxPixels
    ? scaleToPixels(probed.width, probed.height, maxPixels)
    : null;
  let decoded: DecodedImage;
  try {
    decoded = downsample
      ? await deps.decode(file, { resizeWidth: downsample.width, resizeHeight: downsample.height })
      : await deps.decode(file);
  } catch (err) {
    // A decoder the platform actually attempted and refused means damaged or
    // undecodable bytes — mark it so callers do not fall back to shipping the
    // corrupt original. A genuinely missing decoder stays "unavailable".
    if (err instanceof DecodeError) throw err;
    throw new DecodeError("rejected", err instanceof Error ? err.message : "Could not decode the image");
  }
  try {
    // Post-decode bound: platforms without decode-time resize still decode
    // full-size — refuse the giant bitmap (releasing it first) instead of
    // carrying hundreds of MB into canvas encode.
    if (decoded.width * decoded.height > maxPixels) {
      throw new DecodeError("rejected", DECODE_TOO_LARGE);
    }
    if (file.type === "image/gif") {
      // Never round-trip an animation.
      return { blob: file, mimeType: "image/gif", width: decoded.width, height: decoded.height };
    }
    const { width, height } = fitWithin(MAX_EDGE, decoded.width, decoded.height);
    const output = outputTypeFor(file.type, deps.webpSupported);
    const blob = await deps.encode(decoded.source, width, height, output.mimeType, output.quality);
    return { blob, mimeType: output.mimeType, width, height };
  } finally {
    decoded.close?.();
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
 * header is truncated — callers then decode without pre-scaling and enforce
 * the post-decode bound instead.
 */
async function probeFileDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const head = file.slice(0, 65536);
    const buffer = typeof head.arrayBuffer === "function" ? await head.arrayBuffer() : null;
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
