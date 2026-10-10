import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { IMAGES_BUCKET } from "./postsUpload";
import { normalizeImage } from "./image";
import { diag } from "./diag";

/**
 * C3 comment attachment model (local photo/video attach).
 *
 * - Real Storage uploads: files go to the public `findback-images` bucket
 *   under the caller's own folder (`<uid>/<uuid>.<ext>`), the same
 *   ownership-scoped RLS path as report photos — no new bucket, no new
 *   policies. Photos are normalized on-device first (EXIF/orientation, edge
 *   cap — the canonical image pipeline); videos upload as-is.
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

const PHOTO_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);
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
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  const fromName = name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (VIDEO_EXT.has(fromName)) return fromName;
  if (fromName === "png" || fromName === "webp" || fromName === "gif") return fromName;
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
    .from(IMAGES_BUCKET)
    .upload(objectKey, payload, { contentType: mimeType, upsert: false });
  if (uploadError) {
    diag(
      "comments.attach.storage_error",
      { bucket: IMAGES_BUCKET, objectKey, message: uploadError.message },
      { traceId: options.traceId },
    );
    throw new ApiError(uploadError.message || "Upload failed", 502);
  }
  const remoteUrl = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(objectKey).data.publicUrl;
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
      await getSupabase().storage.from(IMAGES_BUCKET).remove([attachment.objectKey]);
    } catch {
      // Orphan cleanup is best-effort; the row was never created server-side.
    }
  }
}
