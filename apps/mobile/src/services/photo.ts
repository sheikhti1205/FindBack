import { Camera, MediaType, MediaTypeSelection, CameraErrorCode } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { sniffImage } from "./media/importImage";
import { detectMotionPhoto } from "./media/motionPhoto";
import { normalizeImage } from "./image";

export interface PickedPhoto {
  nativeUri: string;
  webPath: string;
  format: string;
  id: string;
  motionPhoto?: boolean;
}

export function isNativeCameraAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === CameraErrorCode.TakePhotoCancelled || code === CameraErrorCode.ChooseMediaCancelled;
}

export async function takePhoto(): Promise<PickedPhoto | null> {
  if (!isNativeCameraAvailable()) return null;
  try {
    const result = await Camera.takePhoto({
      quality: 90,
      correctOrientation: true,
      editable: "no",
    });
    if (result.type !== MediaType.Photo) return null;
    const nativeUri = result.uri ?? result.webPath ?? "";
    const webPath = result.webPath ?? result.uri ?? "";
    const format = result.metadata?.format ?? "jpg";
    return { nativeUri, webPath, format, id: crypto.randomUUID() };
  } catch (err) {
    if (isCancellation(err)) return null;
    throw err;
  }
}

export async function chooseFromGallery(): Promise<PickedPhoto | null> {
  if (!isNativeCameraAvailable()) return null;
  try {
    const result = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
    });
    const photo = result.results?.[0];
    if (!photo || photo.type !== MediaType.Photo) return null;
    const nativeUri = photo.uri ?? photo.webPath ?? "";
    const webPath = photo.webPath ?? photo.uri ?? "";
    const format = photo.metadata?.format ?? "jpg";
    return { nativeUri, webPath, format, id: crypto.randomUUID() };
  } catch (err) {
    if (isCancellation(err)) return null;
    throw err;
  }
}

/** Final upload limit enforced against the normalized derivative, not the original. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/**
 * Decode safety bound for the ORIGINAL file. A 12 MB camera original can
 * normalize down to ~1 MB and must be accepted; an unbounded original risks
 * OOM during decode, so genuinely huge inputs are still rejected up front.
 */
export const MAX_ORIGINAL_BYTES = 48 * 1024 * 1024;

export const TOO_LARGE_TO_PROCESS = "That photo is too large to process on this device. Choose a smaller image.";
export const TOO_LARGE_FOR_UPLOAD = "That photo is too large. Choose an image under 8 MB.";

/**
 * Shared normalize-first contract for native AND web picks: decode and
 * normalize (1920px longest edge, EXIF-oriented, re-encoded; animated GIFs
 * pass through untouched), then enforce the upload limit against the
 * RESULTING derivative. When this environment cannot decode (no canvas /
 * bitmap support, e.g. tests), the original bytes are kept and the upload
 * limit still applies to them — so a large-but-decodable original is only
 * ever rejected for its original size above MAX_ORIGINAL_BYTES.
 */
export async function normalizeForUpload(source: File): Promise<File> {
  if (source.size > MAX_ORIGINAL_BYTES) throw new Error(TOO_LARGE_TO_PROCESS);
  try {
    const normalized = await normalizeImage(source);
    const out = new File([normalized.blob], withExtension(source.name, normalized.mimeType), {
      type: normalized.mimeType,
    });
    if (out.size > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE_FOR_UPLOAD);
    return out;
  } catch (err) {
    if (err instanceof Error && (err.message === TOO_LARGE_FOR_UPLOAD || err.message === TOO_LARGE_TO_PROCESS)) throw err;
    if (source.size > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE_FOR_UPLOAD);
    return source;
  }
}

function withExtension(name: string, mimeType: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "jpg";
  return `${base || "photo"}.${ext}`;
}

export async function photoToFile(photo: PickedPhoto, name?: string): Promise<File> {
  const response = await fetch(photo.webPath);
  if (!response.ok) throw new Error("Could not read the selected photo");
  const blob = await response.blob();
  const bytes = new Uint8Array(await blobBytes(blob));
  const kind = sniffImage(bytes);
  const still = kind === "jpeg" ? detectMotionPhoto(bytes) : null;
  photo.motionPhoto = still !== null;
  if (kind === "heic" || kind === "heif") {
    try {
      const source = new File([blob], name ?? `photo.${kind}`, { type: `image/${kind}` });
      const converted = await normalizeImage(source);
      if (converted.blob.size > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE_FOR_UPLOAD);
      return new File([converted.blob], "photo.jpg", { type: "image/jpeg" });
    } catch (err) {
      if (err instanceof Error && err.message === TOO_LARGE_FOR_UPLOAD) throw err;
      throw new Error("This HEIC/HEIF photo could not be decoded on this device. Export it as JPEG and try again.");
    }
  }
  const mime = kind === "jpeg" ? "image/jpeg" : kind === "png" || kind === "png-animated" ? "image/png"
    : kind === "webp" || kind === "webp-animated" ? "image/webp"
    : kind === "gif" || kind === "gif-animated" ? "image/gif" : null;
  if (!mime) throw new Error("Unsupported or unreadable photo. Choose a JPEG, PNG, WebP, or GIF image.");
  const payload = still ? blob.slice(0, still.stillEnd, mime) : blob;
  const extension = mime === "image/jpeg" ? "jpg" : mime.slice(6);
  return normalizeForUpload(new File([payload], name ?? `photo.${extension}`, { type: mime }));
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  // Older Android WebViews and jsdom may expose FileReader but not Blob.arrayBuffer.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** True for object URLs that native code cannot resolve. */
export function isBlobUri(uri: string | null | undefined): boolean {
  return !!uri && uri.startsWith("blob:");
}

/** Native URI safe to pass to LocalVlm, or null when unavailable. Never returns blob:. */
export function toNativeImageUri(photo: PickedPhoto | null): string | null {
  if (!photo) return null;
  const uri = photo.nativeUri?.trim();
  if (!uri || isBlobUri(uri)) return null;
  return uri;
}

function toPickedPhoto(photo: { uri?: string; webPath?: string; metadata?: { format?: string }; type: MediaType }): PickedPhoto {
  const nativeUri = photo.uri ?? photo.webPath ?? "";
  const webPath = photo.webPath ?? photo.uri ?? "";
  const format = photo.metadata?.format ?? "jpg";
  return { nativeUri, webPath, format, id: crypto.randomUUID() };
}

/**
 * Pick multiple photos for a report, respecting remaining capacity (max 5 total).
 * Enforces the 5-photo cap in application code since native picker limit may be ignored.
 */
export async function chooseReportPhotos(remaining: number): Promise<PickedPhoto[]> {
  const capacity = Math.max(0, Math.min(5, Math.floor(remaining)));
  if (!capacity) return [];
  try {
    const { results } = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: true,
      limit: capacity,
      includeMetadata: true,
    });
    return results
      .filter((x) => x.type === MediaType.Photo)
      .map(toPickedPhoto);
  } catch (err) {
    if (isCancellation(err)) return [];
    throw err;
  }
}

/**
 * Capture a single photo for a report using the camera.
 * Preserves existing cancellation semantics from takePhoto.
 */
export async function captureReportPhoto(): Promise<PickedPhoto | null> {
  return takePhoto();
}
