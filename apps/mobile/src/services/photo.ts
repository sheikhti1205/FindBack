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

/**
 * Copy a generic web File into app-private native temp so it gains a
 * native URI supporting preview + VLM + publish. Returns null when the
 * Filesystem plugin is unavailable or the file is too large to copy
 * without base64 of multi-MB images.
 */
export async function copyFileToNativeTemp(file: File): Promise<PickedPhoto | null> {
  if (!isNativeCameraAvailable()) return null;
  if (file.size > 1024 * 1024) return null;
  try {
    const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins;
    const fs = plugins?.Filesystem as
      | {
          writeFile?: (opts: Record<string, unknown>) => Promise<unknown>;
          getUri?: (opts: Record<string, unknown>) => Promise<{ uri?: string }>;
        }
      | undefined;
    if (!fs?.writeFile || !fs?.getUri) return null;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.split(",")[1] ?? "";
    if (!base64) return null;
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 4);
    const name = `upload-${Date.now()}.${ext}`;
    await fs.writeFile({ path: name, data: base64, directory: "CACHE", recursive: true });
    const uriRes = await fs.getUri({ path: name, directory: "CACHE" });
    const nativeUri = uriRes?.uri?.trim() ?? "";
    if (!nativeUri || isBlobUri(nativeUri)) return null;
    return { nativeUri, webPath: nativeUri, format: ext };
  } catch {
    return null;
  }
}