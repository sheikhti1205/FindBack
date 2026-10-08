import { Camera, MediaType, MediaTypeSelection, CameraErrorCode } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { probeDimensions, sniffImage } from "./media/importImage";
import { detectMotionPhoto, strippedVideoBytes } from "./media/motionPhoto";
import { normalizeImage } from "./image";
import { BootTimeoutError, throwIfAborted, withTimeout } from "./timeout";

/**
 * True when the available decoder attempted the file and refused it
 * (image.ts marks these DecodeError/"rejected"). A name+kind check rather
 * than a class import keeps this working when suites mock the image module:
 * only an attempted-and-refused decode skips the original-byte fallback.
 */
function isDecoderRejection(err: unknown): boolean {
  return err instanceof Error
    && (err as { name?: string }).name === "DecodeError"
    && (err as { kind?: string }).kind === "rejected";
}

/**
 * A conversion failure whose message is authored, user-safe, and free of
 * device paths — safe to surface verbatim in per-photo UI. Anything else
 * (network TypeErrors, unexpected failures) must stay generic so private
 * native URIs never leak into the interface.
 */
export class PhotoImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoImportError";
  }
}

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
export const DECODE_FAILED =
  "couldn't be decoded on this device. The file may be damaged — re-save or export it and try again.";

/**
 * Per-stage budgets for the photo pipeline (Lane C part 2). Every
 * potentially-hanging stage — fetch, blob materialization, byte reads,
 * decode/normalize — races its own timer instead of stalling the report flow
 * forever. Camera picks are user-paced and intentionally NOT timed out.
 */
export const PHOTO_FETCH_TIMEOUT_MS = 30_000;
export const PHOTO_BLOB_TIMEOUT_MS = 30_000;
export const PHOTO_BYTES_TIMEOUT_MS = 30_000;
export const PHOTO_NORMALIZE_TIMEOUT_MS = 30_000;
/** Default per-stage budget; override per call via PhotoPipelineOpts.timeoutMs. */
export const PHOTO_STAGE_TIMEOUT_MS = 30_000;

/**
 * Typed timeout for a named pipeline stage. Extends PhotoImportError so the
 * existing safe-surface contract holds: the message is authored, user-safe,
 * and free of device paths.
 */
export class PhotoStageTimeoutError extends PhotoImportError {
  readonly stage: string;

  constructor(stage: string, message?: string) {
    super(message ?? `Photo ${stage} timed out. Check your connection and try again.`);
    this.name = "PhotoStageTimeoutError";
    this.stage = stage;
  }
}

/** Thread-through for abort + per-stage budget across the photo pipeline. */
export interface PhotoPipelineOpts {
  /** AbortSignal that stops fetch, blob, byte reads, and decode. */
  signal?: AbortSignal;
  /** Per-stage budget in ms (default PHOTO_STAGE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Normalized photo file with Motion Photo tail accounting. `videoBytesStripped`
 * is the trailing-MP4 byte count removed from the container (0 for stills):
 * the UI status line can report it instead of the strip passing silently.
 */
export type PhotoFile = File & { videoBytesStripped: number };

function stageMs(opts?: PhotoPipelineOpts): number {
  return opts?.timeoutMs ?? PHOTO_STAGE_TIMEOUT_MS;
}

/** Map a hung stage to the typed timeout; aborts and safe errors pass through. */
function toStageError(err: unknown, stage: string): unknown {
  if (err instanceof BootTimeoutError) return new PhotoStageTimeoutError(stage, err.message);
  return err;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted
    || (err instanceof DOMException && err.name === "AbortError")
    || (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError");
}

/** Content-Length header probe, or null when absent/unparseable. */
function parseContentLength(headers: Headers | undefined | null): number | null {
  try {
    const raw = headers?.get?.("content-length");
    if (raw === null || raw === undefined) return null;
    const parsed = Number(String(raw).trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function withVideoTailInfo(file: File, videoBytesStripped: number): PhotoFile {
  const out = file as PhotoFile;
  out.videoBytesStripped = videoBytesStripped;
  return out;
}

/**
 * Shared normalize-first contract for native AND web picks: decode and
 * normalize (1920px longest edge, EXIF-oriented, re-encoded; animated GIFs
 * pass through untouched), then enforce the upload limit against the
 * RESULTING derivative. When this environment cannot decode (no canvas /
 * bitmap support, e.g. tests), the original bytes are kept and the upload
 * limit still applies to them — so a large-but-decodable original is only
 * ever rejected for its original size above MAX_ORIGINAL_BYTES.
 */
export async function normalizeForUpload(source: File, opts?: PhotoPipelineOpts): Promise<File> {
  throwIfAborted(opts?.signal);
  const budget = stageMs(opts);
  const signal = opts?.signal;
  if (source.size > MAX_ORIGINAL_BYTES) throw new PhotoImportError(TOO_LARGE_TO_PROCESS);
  try {
    const normalized = await withTimeout(
      () => normalizeImage(source, undefined, { signal, timeoutMs: budget }),
      budget,
      "Photo decode timed out",
      signal,
    ).catch((err: unknown) => {
      throw toStageError(err, "normalize");
    });
    throwIfAborted(signal);
    const out = new File([normalized.blob], withExtension(source.name, normalized.mimeType), {
      type: normalized.mimeType,
    });
    if (out.size > MAX_UPLOAD_BYTES) throw new PhotoImportError(TOO_LARGE_FOR_UPLOAD);
    return out;
  } catch (err) {
    // Timeout/abort propagate typed — never mask them with the fallback path.
    if (isAbort(err, signal)) throw err;
    if (err instanceof PhotoStageTimeoutError) throw err;
    if (err instanceof BootTimeoutError) throw new PhotoStageTimeoutError("normalize", err.message);
    if (err instanceof Error && (err.message === TOO_LARGE_FOR_UPLOAD || err.message === TOO_LARGE_TO_PROCESS)) throw err;
    if (isDecoderRejection(err)) {
      // The available decoder ATTEMPTED this file and refused it: header
      // dimensions say nothing about pixel-data integrity, so falling back
      // to the original would only ship a corrupt file that fails at
      // publish time. Fail here with an actionable message instead.
      throw new PhotoImportError(`"${source.name}" ${DECODE_FAILED}`);
    }
    if (source.size > MAX_UPLOAD_BYTES) throw new PhotoImportError(TOO_LARGE_FOR_UPLOAD);
    // The decoder is unavailable (or failed opaquely): do NOT trust the
    // declared MIME type — verify the actual bytes before accepting the
    // original. Magic bytes reject renamed non-photos, the declared-type
    // cross-check rejects mislabeled files, and the header probe rejects
    // truncated/corrupt images that would otherwise fail later at publish.
    throwIfAborted(signal);
    const bytes = new Uint8Array(await withTimeout(
      () => blobBytes(source),
      budget,
      "Photo read timed out",
      signal,
    ).catch((readErr: unknown) => {
      throw toStageError(readErr, "read");
    }));
    throwIfAborted(signal);
    const kind = sniffImage(bytes);
    if (!kind) {
      throw new PhotoImportError(
        `"${source.name}" doesn't look like a photo file. It may be corrupt or renamed — choose a JPEG, PNG, WebP, or GIF photo.`,
      );
    }
    if (!FALLBACK_ACCEPTED_KINDS.has(kind)) {
      throw new PhotoImportError(
        kind === "heic" || kind === "heif"
          ? "This HEIC/HEIF photo could not be decoded on this device. Export it as JPEG and try again."
          : `"${source.name}" looks like ${fallbackBaseKind(kind).toUpperCase()}, which isn't supported here. Choose a JPEG, PNG, WebP, or GIF photo.`,
      );
    }
    const declaredBase = declaredImageBase(source.type);
    if (declaredBase !== null && declaredBase !== fallbackBaseKind(kind)) {
      throw new PhotoImportError(
        `"${source.name}" claims to be ${source.type} but its contents look like ${fallbackBaseKind(kind)}. Re-save the file and try again.`,
      );
    }
    if (probeDimensions(bytes, kind) === null) {
      throw new PhotoImportError(
        `"${source.name}" looks like ${fallbackBaseKind(kind)} but its header is damaged, so it can't be verified. Re-save the file and try again.`,
      );
    }
    return source;
  }
}

/** Accepted kinds for the no-decoder fallback, once their bytes check out. */
const FALLBACK_ACCEPTED_KINDS: ReadonlySet<string> = new Set([
  "jpeg",
  "png",
  "png-animated",
  "gif",
  "gif-animated",
  "webp",
  "webp-animated",
]);

function fallbackBaseKind(kind: string): string {
  return kind.endsWith("-animated") ? kind.slice(0, -"-animated".length) : kind;
}

function declaredImageBase(mimeType: string): string | null {
  const declared = mimeType.trim().toLowerCase();
  if (!declared) return null;
  if (declared === "image/jpeg" || declared === "image/jpg") return "jpeg";
  if (declared === "image/png") return "png";
  if (declared === "image/gif") return "gif";
  if (declared === "image/webp") return "webp";
  // application/octet-stream and unknown types: no claim to check against.
  return null;
}

function withExtension(name: string, mimeType: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "jpg";
  return `${base || "photo"}.${ext}`;
}

export async function photoToFile(photo: PickedPhoto, name?: string, opts?: PhotoPipelineOpts): Promise<PhotoFile> {
  throwIfAborted(opts?.signal);
  const budget = stageMs(opts);
  const signal = opts?.signal;
  let response: Response;
  try {
    response = signal
      ? await withTimeout(() => fetch(photo.webPath, { signal }), budget, "Photo download timed out", signal)
      : await withTimeout(() => fetch(photo.webPath), budget, "Photo download timed out", signal);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    if (err instanceof BootTimeoutError) throw new PhotoStageTimeoutError("fetch", err.message);
    throw new PhotoImportError("Could not read the selected photo");
  }
  if (!response.ok) throw new PhotoImportError("Could not read the selected photo");
  // Size pre-check BEFORE materializing: a declared Content-Length over the
  // decode safety bound rejects without ever calling blob(). The blob.size
  // backstop below still applies when the header is absent or lies.
  const declaredLength = parseContentLength(
    (response as { headers?: Headers }).headers,
  );
  if (declaredLength !== null && declaredLength > MAX_ORIGINAL_BYTES) {
    throw new PhotoImportError(TOO_LARGE_TO_PROCESS);
  }
  let blob: Blob;
  try {
    blob = await withTimeout(() => response.blob(), budget, "Photo read timed out", signal);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    if (err instanceof BootTimeoutError) throw new PhotoStageTimeoutError("read", err.message);
    throw new PhotoImportError("Could not read the selected photo");
  }
  // Memory guard backstop: reject huge natives (camera originals, Motion Photo
  // containers, HEIC) by their reported size before materializing the full
  // bytes or invoking any decoder. Applies to every kind, including HEIC.
  if (blob.size > MAX_ORIGINAL_BYTES) throw new PhotoImportError(TOO_LARGE_TO_PROCESS);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await withTimeout(
      () => blobBytes(blob),
      budget,
      "Photo read timed out",
      signal,
    ));
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    if (err instanceof BootTimeoutError) throw new PhotoStageTimeoutError("read", err.message);
    throw new PhotoImportError("Could not read the selected photo");
  }
  throwIfAborted(signal);
  const kind = sniffImage(bytes);
  const still = kind === "jpeg" ? detectMotionPhoto(bytes) : null;
  photo.motionPhoto = still !== null;
  // Still/tail accounting: only the still reaches the decoder and upload; the
  // trailing MP4 count is surfaced on the result for the UI status line so a
  // stripped container never passes silently.
  const videoBytesStripped = strippedVideoBytes(bytes.length, still?.stillEnd ?? null);
  if (kind === "heic" || kind === "heif") {
    try {
      const source = new File([blob], name ?? `photo.${kind}`, { type: `image/${kind}` });
      const converted = await withTimeout(
        () => normalizeImage(source, undefined, { signal, timeoutMs: budget }),
        budget,
        "Photo decode timed out",
        signal,
      ).catch((err: unknown) => {
        if (err instanceof BootTimeoutError) throw new PhotoStageTimeoutError("normalize", err.message);
        throw err;
      });
      if (converted.blob.size > MAX_UPLOAD_BYTES) throw new PhotoImportError(TOO_LARGE_FOR_UPLOAD);
      return withVideoTailInfo(new File([converted.blob], "photo.jpg", { type: "image/jpeg" }), 0);
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      if (err instanceof PhotoStageTimeoutError) throw err;
      if (err instanceof Error && err.message === TOO_LARGE_FOR_UPLOAD) throw err;
      throw new PhotoImportError("This HEIC/HEIF photo could not be decoded on this device. Export it as JPEG and try again.");
    }
  }
  const mime = kind === "jpeg" ? "image/jpeg" : kind === "png" || kind === "png-animated" ? "image/png"
    : kind === "webp" || kind === "webp-animated" ? "image/webp"
    : kind === "gif" || kind === "gif-animated" ? "image/gif" : null;
  if (!mime) throw new PhotoImportError("Unsupported or unreadable photo. Choose a JPEG, PNG, WebP, or GIF image.");
  const payload = still ? blob.slice(0, still.stillEnd, mime) : blob;
  // Still-level backstop: the still alone must fit the decode bound even when
  // the container already passed it (tail accounted separately above).
  if (payload.size > MAX_ORIGINAL_BYTES) throw new PhotoImportError(TOO_LARGE_TO_PROCESS);
  const extension = mime === "image/jpeg" ? "jpg" : mime.slice(6);
  const normalized = await normalizeForUpload(new File([payload], name ?? `photo.${extension}`, { type: mime }), opts);
  return withVideoTailInfo(normalized, videoBytesStripped);
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  // Older Android WebViews and jsdom may expose FileReader but not Blob.arrayBuffer.
  // Same deterministic contract as photoBytes.buffer: current-realm copy,
  // current-realm Error, no hang when FileReader is absent.
  if (typeof FileReader !== "function") return Promise.reject(new Error("unreadable file"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(new Uint8Array(reader.result as ArrayBuffer).slice().buffer);
      } catch {
        reject(new Error("unreadable file"));
      }
    };
    reader.onerror = () => reject(new Error("unreadable file"));
    try {
      reader.readAsArrayBuffer(blob);
    } catch {
      reject(new Error("unreadable file"));
    }
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
