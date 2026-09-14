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

const ALLOWED_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

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

export interface ImageDeps {
  decode(file: File): Promise<DecodedImage>;
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

export async function normalizeImage(
  file: File,
  deps: ImageDeps = browserDeps(),
): Promise<NormalizedImage> {
  if (!ALLOWED_MIME.includes(file.type)) {
    throw new Error("Unsupported image type");
  }
  const decoded = await deps.decode(file);
  try {
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

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
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
      reject(new Error("Could not read the image"));
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
