/**
 * Storage seam for uploaded listing images.
 *
 * The Node API is the only writer: it validates and normalizes the bytes, then
 * hands them to the active provider. Production writes to Supabase Storage;
 * tests and the local demo write to disk (`LocalStorageProvider`).
 */

/** The subset of an upload the public API returns. */
export interface StoredUpload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
}

/**
 * Internal result of a write. `objectKey` is a backend-only handle used to
 * remove the object if the following DB insert fails. It is deliberately
 * stripped before any API response — never serialize it to clients.
 */
export interface StoredObject extends StoredUpload {
  objectKey: string;
}

export interface StorageSaveContext {
  /** Authenticated owner id; used only as an opaque path namespace. */
  userId: string;
  /** Application-generated object id (defaults to a fresh UUID). */
  id?: string;
}

export interface StorageProvider {
  /** Persist normalized bytes and return the stored object (including rollback key). */
  save(
    buffer: Buffer,
    mimeType: string,
    originalName: string,
    context: StorageSaveContext,
  ): Promise<StoredObject>;
  /** Remove exactly one object previously written by `save`. */
  remove(objectKey: string): Promise<void>;
}

/** Safe display filename for metadata. Never used as a storage object key. */
export function sanitizeFileName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? originalName;
  return base.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "upload";
}
