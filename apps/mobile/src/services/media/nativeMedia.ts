import { Capacitor, registerPlugin } from "@capacitor/core";
import { IMPORT_MAX_DERIVATIVE_BYTES, IMPORT_MAX_EDGE, MediaError, probeDimensions, sniffImage, type ImportedImage, type SniffedKind } from "./importImage";

export type NativeMediaSource = "photos" | "camera" | "files";
export interface NativeMediaOptions { highQuality?: boolean; text?: string; fileName?: string }
export interface NativeMediaDerivative {
  derivativeBase64: string;
  width: number;
  height: number;
  mimeType: string;
  sourceKind: SniffedKind;
  originalByteLength: number;
  motionStillUsed: boolean;
  videoBytesStripped: number;
  sampledStill: boolean;
  locationMetadataStripped: boolean;
  orientation: number;
  quality: number | null;
}
interface MediaPlugin {
  chooseImage(options: { source: NativeMediaSource; highQuality: boolean }): Promise<NativeMediaDerivative | { cancelled: true }>;
  importUri(options: { uri: string; highQuality: boolean }): Promise<NativeMediaDerivative>;
}
const plugin = registerPlugin<MediaPlugin>("FindbackMedia");
export function isNativeMediaIntakeAvailable(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("FindbackMedia");
}
function requireAndroid(): void {
  if (!isNativeMediaIntakeAvailable()) throw new MediaError("UNSUPPORTED_FORMAT", "Native photo preparation is not available here.");
}

/** Only DERIVATIVE bytes cross this bridge. Never accept a File/original base64 here. */
function importedDerivative(result: NativeMediaDerivative, options: NativeMediaOptions): ImportedImage {
  const invalid = () => new MediaError("CORRUPT_IMAGE", "Couldn't safely prepare this photo. Try a different photo or re-save it as JPEG.");
  if (typeof result.derivativeBase64 !== "string" || result.derivativeBase64.length > Math.ceil(IMPORT_MAX_DERIVATIVE_BYTES / 3) * 4 || result.locationMetadataStripped !== true) throw invalid();
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(result.derivativeBase64), (char) => char.charCodeAt(0)); } catch { throw invalid(); }
  const kind = sniffImage(bytes);
  const dimensions = kind ? probeDimensions(bytes, kind) : null;
  if (bytes.length === 0 || bytes.length > IMPORT_MAX_DERIVATIVE_BYTES || !dimensions || dimensions.width !== result.width || dimensions.height !== result.height || result.width > IMPORT_MAX_EDGE || result.height > IMPORT_MAX_EDGE || (result.mimeType !== "image/jpeg" && result.mimeType !== "image/png") || (kind !== "jpeg" && kind !== "png") || result.mimeType !== `image/${kind}`) throw invalid();
  const kinds: readonly string[] = ["jpeg", "png", "png-animated", "webp", "webp-animated", "gif", "gif-animated", "bmp", "heic", "heif", "avif", "tiff"];
  if (!kinds.includes(result.sourceKind) || !Number.isSafeInteger(result.originalByteLength) || result.originalByteLength <= 0 || !Number.isSafeInteger(result.videoBytesStripped) || result.videoBytesStripped < 0 || !Number.isInteger(result.orientation) || result.orientation < 1 || result.orientation > 8) throw invalid();
  const id = `img_${crypto.randomUUID().replaceAll("-", "_")}`;
  return {
    id, fileName: options.fileName ?? `photo.${kind === "jpeg" ? "jpg" : "png"}`, text: options.text ?? "", sniffed: result.sourceKind,
    declaredMimeType: "", originalByteLength: result.originalByteLength, animated: false,
    motionStillUsed: result.motionStillUsed === true, videoBytesStripped: result.videoBytesStripped,
    sampledStill: result.sampledStill === true, exifOrientationApplied: result.orientation, locationMetadataStripped: true,
    derivative: { bytes, mimeType: result.mimeType, byteLength: bytes.length, width: result.width, height: result.height, quality: result.quality },
    preview: { mimeType: result.mimeType, byteLength: bytes.length, width: result.width, height: result.height, animated: false },
  };
}

/** Main Help/composer should call this INSTEAD OF the Android HTML File input. null = user cancelled. */
export async function chooseNativeImage(options: NativeMediaOptions & { source: NativeMediaSource }): Promise<ImportedImage | null> {
  requireAndroid();
  const result = await plugin.chooseImage({ source: options.source, highQuality: options.highQuality === true });
  return "cancelled" in result ? null : importedDerivative(result, options);
}

/** For another native picker supplying a transient granted content URI; no raw paths or network URLs. */
export async function importNativeImageUri(uri: string, options: NativeMediaOptions = {}): Promise<ImportedImage> {
  requireAndroid();
  if (!/^content:\/\/[^/]+\//.test(uri)) throw new MediaError("UNRECOGNIZED_FORMAT", "Please choose a photo through the device photo picker.");
  return importedDerivative(await plugin.importUri({ uri, highQuality: options.highQuality === true }), options);
}
