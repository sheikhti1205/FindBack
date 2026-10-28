/** Private-chat preparation only. No upload, storage, URL or original fallback. */
import { normalizeImage, type ImageDeps } from "../image";
import { MediaError, probeDimensions, sniffImage } from "../media/importImage";
import { PROBE_BYTES, SOURCE_LIMIT_MESSAGE, SOURCE_MAX_BYTES } from "../media/mediaPolicy";
import { throwIfAborted, withTimeout } from "../timeout";
import { isMediaMime, MEDIA_MAX_BYTES, MEDIA_MAX_EDGE, sha256Hex, type MediaMime } from "./media";

export interface PreparedMessagingPhoto {
  bytes: ArrayBuffer;
  sha256: string;
  mime: MediaMime;
  byteSize: number;
  width: number;
  height: number;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  // Older WebViews can lack Blob.arrayBuffer while providing FileReader.
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== "function") { reject(new Error("Photo read unavailable")); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer).slice().buffer);
    reader.onerror = () => reject(new Error("Photo read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Web passes a selected File; Android passes ONLY the bounded derivative from
 * canonical native URI intake. The codec remains image.ts, never a chat copy.
 * IDs belong to the durable draft owner and must survive uncertain admission.
 */
export async function prepareMessagingPhoto(source: File,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}, deps?: ImageDeps): Promise<PreparedMessagingPhoto> {
  const { signal } = opts, timeoutMs = opts.timeoutMs ?? 30_000;
  throwIfAborted(signal);
  if (source.size > SOURCE_MAX_BYTES) throw new MediaError("OVERSIZED_INPUT", SOURCE_LIMIT_MESSAGE);
  const failed = () => new MediaError("CORRUPT_IMAGE", "Couldn't safely prepare this photo. Try again or re-save it as JPEG or PNG.");
  if (source.size <= 0) throw failed();
  try {
    const header = new Uint8Array(await withTimeout(() => readBlob(source.slice(0, PROBE_BYTES)), timeoutMs, "Photo read timed out", signal));
    throwIfAborted(signal);
    const kind = sniffImage(header), base = kind?.replace("-animated", "");
    if (!base || !["jpeg", "png", "webp", "gif", "bmp", "heic", "heif", "avif"].includes(base)) throw failed();
    const mime = `image/${base}`;
    const declared = source.type.toLowerCase().replace("image/jpg", "image/jpeg");
    const generic = declared === "" || declared === "application/octet-stream" || declared === "binary/octet-stream";
    const heifFamily = ["image/heic", "image/heif"].includes(declared) && ["heic", "heif"].includes(base);
    if (!generic && declared !== mime && !heifFamily) {
      throw new MediaError("MIME_MISMATCH", "This photo's contents don't match its file type. Re-save it and try again.");
    }
    // File construction wraps the Blob; it does not materialize source-sized JS
    // bytes. The canonical normalizer probes/samples before pixel work.
    const normalized = await normalizeImage(new File([source], "photo", { type: mime }), deps,
      { signal, timeoutMs, animation: "still" });
    throwIfAborted(signal);
    if (!isMediaMime(normalized.mimeType) || normalized.blob.type !== normalized.mimeType
      || normalized.blob.size <= 0 || normalized.blob.size > MEDIA_MAX_BYTES) throw failed();
    const bytes = await withTimeout(() => readBlob(normalized.blob), timeoutMs, "Photo read timed out", signal);
    throwIfAborted(signal);
    const output = new Uint8Array(bytes), outputKind = sniffImage(output);
    const dimensions = outputKind ? probeDimensions(output, outputKind) : null;
    if (outputKind !== normalized.mimeType.slice(6) || !dimensions
      || dimensions.width !== normalized.width || dimensions.height !== normalized.height
      || dimensions.width > MEDIA_MAX_EDGE || dimensions.height > MEDIA_MAX_EDGE
      || bytes.byteLength !== normalized.blob.size) throw failed();
    const sha256 = await withTimeout(() => sha256Hex(bytes), timeoutMs, "Photo preparation timed out", signal);
    throwIfAborted(signal);
    return { bytes, sha256, mime: normalized.mimeType, byteSize: bytes.byteLength, ...dimensions };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // Never display a native URI, filename or platform decoder exception.
    if (error instanceof MediaError && error.code === "MIME_MISMATCH") throw error;
    throw failed();
  }
}
