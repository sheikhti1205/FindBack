import { getStore } from "../db/index.js";
import { AppError, nowIso } from "./helpers.js";
import { normalizeImage } from "../storage/imageNormalizer.js";
import { getStorageProvider } from "../storage/index.js";
import type { StoredUpload } from "../storage/storageProvider.js";
import type { Row } from "../db/index.js";

export type { StorageProvider, StoredUpload } from "../storage/storageProvider.js";
export { FINDBACK_IMAGES_BUCKET } from "../storage/supabaseStorageProvider.js";

/**
 * Validate + normalize the uploaded image, persist it through the active
 * StorageProvider, then record the `uploads` row.
 *
 * Ordering matters: if the object write succeeds but the DB insert fails, the
 * just-written object is removed so we never leave an orphan. A failed object
 * write means no `uploads` row is created at all.
 */
export async function recordUpload(
  userId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<StoredUpload> {
  let normalized;
  try {
    normalized = await normalizeImage(file.buffer, file.mimetype);
  } catch {
    throw new AppError(400, "Unsupported or corrupt image file");
  }

  const provider = getStorageProvider();
  const stored = await provider.save(
    normalized.buffer,
    normalized.mimeType,
    file.originalname,
    { userId },
  );
  const { objectKey, ...upload } = stored;

  try {
    await getStore().insertUpload({
      id: upload.id,
      user_id: userId,
      file_name: upload.fileName,
      mime_type: upload.mimeType,
      file_size: upload.fileSize,
      file_url: upload.fileUrl,
      created_at: nowIso(),
    });
  } catch (err) {
    // Roll back only this object; never touch unrelated objects.
    await provider.remove(objectKey).catch(() => {});
    throw err;
  }

  return upload;
}

export function getUpload(id: string): Promise<Row | undefined> {
  return getStore().findUploadById(id);
}
