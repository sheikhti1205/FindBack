import { ApiError } from "./session";
import { normalizeImage } from "./image";
import { getSupabase } from "./supabaseClient";
import { diag } from "./diag";

export interface StoredUpload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
  objectKey: string;
}

const IMAGES_BUCKET = "findback-images";

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "image").slice(0, 120);
}

/**
 * Normalize an image on this device, upload it straight to Supabase Storage under
 * the caller's own folder, then stage an `uploads` row the create-post RPC binds.
 * If staging fails the just-uploaded object is removed so nothing is orphaned.
 */
export async function uploadImage(file: File, traceId?: string): Promise<StoredUpload> {
  const start = Date.now();
  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    diag("posts.upload.auth_error", { message: "Not authenticated" }, { traceId });
    throw new ApiError("Not authenticated", 401);
  }

  const normalized = await normalizeImage(file);
  const id = crypto.randomUUID();
  const objectKey = `${userData.user.id}/${id}.${extensionFor(normalized.mimeType)}`;

  const uploadStart = Date.now();
  const { error: uploadError } = await supabase.storage
    .from(IMAGES_BUCKET)
    .upload(objectKey, normalized.blob, {
      contentType: normalized.mimeType,
      upsert: false,
    });
  const uploadMs = Date.now() - uploadStart;
  if (uploadError) {
    diag("posts.upload.storage_error", {
      bucket: IMAGES_BUCKET,
      objectKey,
      message: uploadError.message,
      ms: uploadMs,
    }, { traceId });
    throw new ApiError(uploadError.message || "Upload failed", 502);
  }

  const fileUrl = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(objectKey).data.publicUrl;
  const fileName = safeFileName(file.name);
  const stageStart = Date.now();
  const { error: stageError } = await supabase.from("uploads").insert({
    id,
    user_id: userData.user.id,
    file_name: fileName,
    mime_type: normalized.mimeType,
    file_size: normalized.blob.size,
    file_url: fileUrl,
    created_at: new Date().toISOString(),
  });
  const stageMs = Date.now() - stageStart;
  if (stageError) {
    diag("posts.upload.stage_error", {
      table: "uploads",
      message: stageError.message,
      ms: stageMs,
    }, { traceId });
    const { error: rollbackError } = await supabase.storage.from(IMAGES_BUCKET).remove([objectKey]);
    if (rollbackError) {
      diag("posts.upload.rollback_error", {
        bucket: IMAGES_BUCKET,
        objectKey,
        message: rollbackError.message,
      }, { traceId });
      throw new ApiError(
        `Could not stage the upload and could not remove the uploaded object (${rollbackError.message}). ` +
          "It may need manual cleanup.",
        500,
      );
    }
    throw new ApiError(stageError.message || "Could not stage the upload", 500);
  }

  diag("posts.upload.success", {
    id,
    objectKey,
    bytes: normalized.blob.size,
    mimeType: normalized.mimeType,
    uploadMs,
    stageMs,
    totalMs: Date.now() - start,
  }, { traceId });

  return {
    id,
    fileName,
    mimeType: normalized.mimeType,
    fileSize: normalized.blob.size,
    fileUrl,
    objectKey,
  };
}

export async function removeStagedUpload(stored: StoredUpload, traceId?: string): Promise<void> {
  const supabase = getSupabase();
  // Supabase reports operation failures in { error }, it does not always
  // throw — ignoring it orphans the Storage object while the staging row
  // disappears, so both results are checked.
  const removeStart = Date.now();
  const { error: removeError } = await supabase.storage
    .from(IMAGES_BUCKET)
    .remove([stored.objectKey]);
  const removeMs = Date.now() - removeStart;
  if (removeError) {
    diag("posts.upload.remove_storage_error", {
      bucket: IMAGES_BUCKET,
      objectKey: stored.objectKey,
      message: removeError.message,
      ms: removeMs,
    }, { traceId });
    throw new ApiError(removeError.message || "Could not remove the uploaded photo", 502);
  }
  const deleteStart = Date.now();
  const { error: deleteError } = await supabase.from("uploads").delete().eq("id", stored.id);
  const deleteMs = Date.now() - deleteStart;
  if (deleteError) {
    diag("posts.upload.remove_stage_error", {
      table: "uploads",
      id: stored.id,
      message: deleteError.message,
      ms: deleteMs,
    }, { traceId });
    throw new ApiError(deleteError.message || "Could not remove the staged upload", 500);
  }
  diag("posts.upload.remove_success", {
    id: stored.id,
    objectKey: stored.objectKey,
    removeMs,
    deleteMs,
  }, { traceId });
}
