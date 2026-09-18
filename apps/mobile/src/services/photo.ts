import { Camera, MediaType, MediaTypeSelection, CameraErrorCode } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";

export interface PickedPhoto {
  nativeUri: string;
  webPath: string;
  format: string;
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
    return { nativeUri, webPath, format };
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
    return { nativeUri, webPath, format };
  } catch (err) {
    if (isCancellation(err)) return null;
    throw err;
  }
}

export async function photoToFile(photo: PickedPhoto, name?: string): Promise<File> {
  const response = await fetch(photo.webPath);
  const blob = await response.blob();
  const fileName = name ?? `photo.${photo.format}`;
  return new File([blob], fileName, { type: blob.type || "image/jpeg" });
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