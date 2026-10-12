import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { normalizeImage } from "./image";
import { diag } from "./diag";
import { ACCEPTED_STILL_MIME_TYPES } from "./media/mediaPolicy";
import type { ImportedImage } from "./media/importImage";

/**
 * C3 comment attachment model (local photo/video attach).
 *
 * - Real Storage uploads: files go to the public `findback-comment-media`
 *   bucket under the caller's own folder (`<uid>/<uuid>.<ext>`), the same
 *   ownership-scoped RLS convention as report photos. Photos are normalized
 *   on-device first (EXIF/orientation, edge cap — the canonical image
 *   pipeline); videos upload as-is.
 * - Never base64 in text: previews are `blob:` object URLs (or the provider
 *   URL for Klipy picks); the comment body carries only `https://` remote
 *   URLs (see `commentBodyMedia`). The body never contains `data:` URLs.
 * - States: `ready` (picked) → `uploading` (progress 0→1, indeterminate
 *   activity while the Storage client works) → `uploaded` | `failed`
 *   (retryable, removable). `removeCommentAttachment` revokes the preview
 *   and best-effort deletes the uploaded object so nothing is orphaned.
 */

export const COMMENT_ATTACH_MAX = 4;
export const COMMENT_ATTACH_MAX_BYTES = 25_000_000;

/**
 * Deliberate video path: short clips upload by streaming the picked
 * File/Blob bytes straight to Storage (never base64, never a data: URL in
 * the body). The client pre-upload cap below is intentionally IDENTICAL to
 * the bucket `file_size_limit` enforced server-side (see the FBX-013
 * migration test), so a clip the client accepts can never fail the Storage
 * gate after the UI promised success. There is no duration probe on the
 * client — length is bounded by the byte cap plus the picker's short-clip
 * affordance, a conservative policy documented here instead of enforced by
 * an unreliable metadata read.
 */
export const COMMENT_VIDEO_MAX_BYTES = COMMENT_ATTACH_MAX_BYTES;
/** Video containers the picker, the client gate, and the bucket all accept. */
export const COMMENT_VIDEO_MIME: readonly string[] = ["video/mp4", "video/webm", "video/quicktime"];
/** Single `accept` string for the composer file input (photos + short video). */
export const COMMENT_ATTACH_ACCEPT = "image/*,video/mp4,video/webm,video/quicktime";

/**
 * Dedicated public bucket for comment attachments (FBX-013).
 *
 * Comment media cannot share the report image bucket: that bucket's row pins
 * 8 MB and an images-only MIME list, while comment attachments allow 25 MB
 * and video. Storage enforces the bucket row server-side, so a shared bucket
 * made every video attach (and any photo over 8 MB) fail after the client had
 * already promised success. The report bucket keeps its 8 MB images-only
 * policy untouched; this bucket's `file_size_limit` mirrors
 * `COMMENT_ATTACH_MAX_BYTES` exactly so the two caps cannot drift apart.
 */
export const COMMENT_MEDIA_BUCKET = "findback-comment-media";

/**
 * Photo MIME set — derived from the canonical ACCEPTED_STILL_MIME_TYPES
 * (L-CONSOLIDATE: mediaPolicy owns the value; the 25 MB cap and the
 * dedicated bucket below stay comment-specific and untouched). Comments
 * accept exactly the stills the report pipeline advertises — a narrower set
 * here would be a deliberate user-visible inconsistency, not a safety bound.
 */
const PHOTO_MIME = new Set<string>(ACCEPTED_STILL_MIME_TYPES);
const VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

export type CommentAttachmentKind = "photo" | "video" | "gif";
export type CommentAttachmentStatus = "ready" | "uploading" | "uploaded" | "failed";

export interface CommentAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  kind: CommentAttachmentKind;
  status: CommentAttachmentStatus;
  /** 0..1 upload progress (0 at start, 1 when the remote URL resolves). */
  progress: number;
  /** Local preview (`blob:` object URL) or the provider preview for GIFs. */
  previewUrl: string;
  /** `https://` remote URL once uploaded (Storage public URL or Klipy media URL). */
  remoteUrl?: string;
  /** Storage object key for cleanup (local uploads only). */
  objectKey?: string;
  /** Klipy provider identity for share-tracking (gif picks only). */
  klipySlug?: string;
  klipyKind?: "gifs" | "stickers";
  error?: string;
}

export interface AttachmentUploadProgress {
  loaded: number;
  total: number;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `att-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

function previewForFile(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

function extensionFor(mimeType: string, name: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  if (mimeType === "image/bmp") return "bmp";
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  const fromName = name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (VIDEO_EXT.has(fromName)) return fromName;
  if (fromName === "png" || fromName === "webp" || fromName === "gif" || fromName === "avif" || fromName === "bmp") return fromName;
  return "jpg";
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "attachment").slice(0, 120);
}

/** Human-readable validation; null when the file is attachable. */
export function validateAttachableFile(file: File): string | null {
  const type = (file.type || "").toLowerCase();
  if (!PHOTO_MIME.has(type) && !VIDEO_MIME.has(type)) {
    return "That file can't be attached. Pick a photo or a short video instead.";
  }
  if (file.size <= 0) return "That file looks empty. Pick another photo or video.";
  if (file.size > COMMENT_ATTACH_MAX_BYTES) {
    return "That file is too large to attach (25 MB limit). Pick a smaller one.";
  }
  return null;
}

/** Build a `ready` entry for a picked file (preview is a blob URL, never base64). */
export function createCommentAttachment(file: File): CommentAttachment {
  const type = (file.type || "").toLowerCase();
  const kind: CommentAttachmentKind = VIDEO_MIME.has(type) ? "video" : "photo";
  return {
    id: newId(),
    fileName: safeFileName(file.name),
    mimeType: file.type || (kind === "video" ? "video/mp4" : "image/jpeg"),
    kind,
    status: "ready",
    progress: 0,
    previewUrl: previewForFile(file),
  };
}

/** Build an entry for a Klipy GIF/sticker pick (provider URLs preserved verbatim). */
export function createKlipyAttachment(input: {
  slug: string;
  kind: "gifs" | "stickers";
  mediaUrl: string;
  previewUrl: string;
  title?: string;
}): CommentAttachment {
  return {
    id: newId(),
    fileName: (input.title ?? input.slug).slice(0, 120) || "gif",
    mimeType: "image/gif",
    kind: "gif",
    status: "uploaded",
    progress: 1,
    previewUrl: input.previewUrl,
    remoteUrl: input.mediaUrl,
    klipySlug: input.slug,
    klipyKind: input.kind,
  };
}

/**
 * Canonical native photo intake for comments (FBX-038): an already-prepared
 * native derivative (`FindbackMedia` — EXIF applied, edges capped,
 * metadata stripped) becomes the composer entry plus its upload File. The
 * bytes are the bounded derivative, never a source original, and the preview
 * is a `blob:` object URL, never base64. Videos never enter through here —
 * they use the deliberate streaming file-input path above.
 *
 * The native bridge is dynamically imported (never a static import): this
 * module sits in the composer import graph, which loads in suites that
 * partially mock `@capacitor/core`, so touching the plugin registry at load
 * would break them.
 */
export async function createCommentAttachmentFromImportedImage(item: ImportedImage): Promise<{
  entry: CommentAttachment;
  file: File;
}> {
  const { importedImageToFile } = await import("./media/nativeMedia");
  const file = importedImageToFile(item);
  return { entry: createCommentAttachment(file), file };
}

/**
 * True only in the Android app with the canonical photo intake registered.
 * Async for the same load-graph reason as above: the platform probe
 * dynamically imports `@capacitor/core` instead of binding it at load.
 */
export async function isNativeCommentPhotoIntakeAvailable(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("FindbackMedia");
  } catch {
    return false;
  }
}

/**
 * One native photo URI → a ready composer entry plus its upload File, via
 * the canonical intake (`importNativeImageUri` preparation, then the
 * derivative-to-entry wrapper above). Rejects when the URI is unreadable —
 * callers keep successfully prepared siblings and report the failure with
 * consumer copy, never a dropped strip.
 */
export async function importCommentPhotoFromNativeUri(uri: string): Promise<{
  entry: CommentAttachment;
  file: File;
}> {
  const { importNativeImageUri } = await import("./media/nativeMedia");
  return createCommentAttachmentFromImportedImage(await importNativeImageUri(uri));
}

export interface UploadAttachmentOptions {
  onProgress?: (progress: AttachmentUploadProgress) => void;
  traceId?: string;
}

/**
 * Upload one attachment to Storage and resolve its public URL. Photos are
 * normalized on-device first (same pipeline as report photos); videos go
 * raw. Reports progress at start (0) and completion (1) — the Storage JS
 * client exposes no byte-level callbacks, so the UI renders an honest
 * indeterminate activity between those two states, never a fake percentage.
 */
export async function uploadCommentAttachment(
  attachment: CommentAttachment,
  file: File,
  options: UploadAttachmentOptions = {},
): Promise<{ remoteUrl: string; objectKey: string }> {
  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    diag("comments.attach.auth_error", { message: "Not authenticated" }, { traceId: options.traceId });
    throw new ApiError("Not authenticated", 401);
  }
  options.onProgress?.({ loaded: 0, total: file.size });

  let payload: Blob = file;
  let mimeType = attachment.mimeType;
  if (attachment.kind === "photo") {
    const normalized = await normalizeImage(file);
    payload = normalized.blob;
    mimeType = normalized.mimeType;
  }
  const objectKey = `${userData.user.id}/${newId()}.${extensionFor(mimeType, attachment.fileName)}`;
  const { error: uploadError } = await supabase.storage
    .from(COMMENT_MEDIA_BUCKET)
    .upload(objectKey, payload, { contentType: mimeType, upsert: false });
  if (uploadError) {
    diag(
      "comments.attach.storage_error",
      { bucket: COMMENT_MEDIA_BUCKET, objectKey, message: uploadError.message },
      { traceId: options.traceId },
    );
    throw new ApiError(uploadError.message || "Upload failed", 502);
  }
  const remoteUrl = supabase.storage.from(COMMENT_MEDIA_BUCKET).getPublicUrl(objectKey).data.publicUrl;
  options.onProgress?.({ loaded: file.size, total: file.size });
  diag(
    "comments.attach.success",
    { objectKey, bytes: payload.size, mimeType },
    { traceId: options.traceId },
  );
  return { remoteUrl, objectKey };
}

/**
 * Remove an entry: revoke the blob preview and best-effort delete the
 * uploaded Storage object (Klipy picks have no object to delete). Never
 * throws — cleanup must not mask the original error.
 */
export async function removeCommentAttachment(attachment: CommentAttachment): Promise<void> {
  if (attachment.previewUrl.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(attachment.previewUrl);
    } catch {
      // Revocation is best-effort.
    }
  }
  if (attachment.objectKey && attachment.remoteUrl) {
    try {
      await getSupabase().storage.from(COMMENT_MEDIA_BUCKET).remove([attachment.objectKey]);
    } catch {
      // Orphan cleanup is best-effort; the row was never created server-side.
    }
  }
}
