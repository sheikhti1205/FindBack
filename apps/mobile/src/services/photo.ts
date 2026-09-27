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
      if (converted.blob.size > 8 * 1024 * 1024) throw new Error("Converted photo exceeds the 8 MB upload limit");
      return new File([converted.blob], "photo.jpg", { type: "image/jpeg" });
    } catch {
      throw new Error("This HEIC/HEIF photo could not be decoded on this device. Export it as JPEG and try again.");
    }
  }
  const mime = kind === "jpeg" ? "image/jpeg" : kind === "png" || kind === "png-animated" ? "image/png"
    : kind === "webp" || kind === "webp-animated" ? "image/webp"
    : kind === "gif" || kind === "gif-animated" ? "image/gif" : null;
  if (!mime) throw new Error("Unsupported or unreadable photo. Choose a JPEG, PNG, WebP, or GIF image.");
  const payload = still ? blob.slice(0, still.stillEnd, mime) : blob;
  if (payload.size > 8 * 1024 * 1024) throw new Error("That photo is too large. Choose an image under 8 MB.");
  const extension = mime === "image/jpeg" ? "jpg" : mime.slice(6);
  return new File([payload], name ?? `photo.${extension}`, { type: mime });
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
