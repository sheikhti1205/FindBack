import { ApiError } from "./session";
import { normalizeImage } from "./image";
import { getSupabase } from "./supabaseClient";

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
export async function uploadImage(file: File): Promise<StoredUpload> {
  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new ApiError("Not authenticated", 401);

  const normalized = await normalizeImage(file);
  const id = crypto.randomUUID();
  const objectKey = `${userData.user.id}/${id}.${extensionFor(normalized.mimeType)}`;

  const { error: uploadError } = await supabase.storage
    .from(IMAGES_BUCKET)
    .upload(objectKey, normalized.blob, {
      contentType: normalized.mimeType,
      upsert: false,
    });
  if (uploadError) throw new ApiError(uploadError.message || "Upload failed", 502);

  const fileUrl = supabase.storage.from(IMAGES_BUCKET).getPublicUrl(objectKey).data.publicUrl;
  const fileName = safeFileName(file.name);
  const { error: stageError } = await supabase.from("uploads").insert({
    id,
    user_id: userData.user.id,
    file_name: fileName,
    mime_type: normalized.mimeType,
    file_size: normalized.blob.size,
    file_url: fileUrl,
    created_at: new Date().toISOString(),
  });
  if (stageError) {
    await supabase.storage.from(IMAGES_BUCKET).remove([objectKey]);
    throw new ApiError(stageError.message || "Could not stage the upload", 500);
  }

  return {
    id,
    fileName,
    mimeType: normalized.mimeType,
    fileSize: normalized.blob.size,
    fileUrl,
    objectKey,
  };
}

export async function removeStagedUpload(stored: StoredUpload): Promise<void> {
  const supabase = getSupabase();
  try {
    await supabase.storage.from(IMAGES_BUCKET).remove([stored.objectKey]);
  } catch {
    /* best effort: the staging delete below still runs */
  }
  await supabase.from("uploads").delete().eq("id", stored.id);
}
