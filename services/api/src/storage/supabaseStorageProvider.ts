import { AppError } from "../domain/helpers.js";
import { newId } from "../domain/helpers.js";
import {
  sanitizeFileName,
  type StorageProvider,
  type StorageSaveContext,
  type StoredObject,
} from "./storageProvider.js";

export const FINDBACK_IMAGES_BUCKET = "findback-images";

/**
 * Narrow structural view of the Supabase Storage calls we use. Keeping it this
 * small means tests can inject a fake and never touch the network.
 */
export interface SupabaseStorageOperations {
  upload(
    path: string,
    buffer: Buffer,
    options: { contentType: string; upsert: boolean },
  ): Promise<{ errorMessage: string | null }>;
  remove(paths: string[]): Promise<{ errorMessage: string | null }>;
  getPublicUrl(path: string): string;
}

/** Namespace the object key by owner, stripping anything path-like. */
function safeNamespace(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anonymous";
}

/**
 * Supabase Storage adapter for the public `findback-images` bucket.
 *
 * Object keys are `<userId>/<uploadId>` where both parts are application-owned
 * opaque ids, so a client-supplied filename (or path) can never influence the
 * stored key. Reads use the public URL; writes and deletes go only through the
 * backend-only secret-key client.
 */
export class SupabaseStorageProvider implements StorageProvider {
  constructor(private readonly ops: SupabaseStorageOperations) {}

  async save(
    buffer: Buffer,
    mimeType: string,
    originalName: string,
    context: StorageSaveContext,
  ): Promise<StoredObject> {
    const id = context.id ?? newId();
    const objectKey = `${safeNamespace(context.userId)}/${id}`;
    const { errorMessage } = await this.ops.upload(objectKey, buffer, {
      contentType: mimeType,
      upsert: false,
    });
    if (errorMessage) throw new AppError(502, "Storing the image failed");
    return {
      id,
      objectKey,
      fileName: sanitizeFileName(originalName),
      mimeType,
      fileSize: buffer.byteLength,
      fileUrl: this.ops.getPublicUrl(objectKey),
    };
  }

  async remove(objectKey: string): Promise<void> {
    const { errorMessage } = await this.ops.remove([objectKey]);
    if (errorMessage) throw new AppError(502, "Removing the stored image failed");
  }
}
