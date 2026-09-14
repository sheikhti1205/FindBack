import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { newId } from "../domain/helpers.js";
import {
  sanitizeFileName,
  type StorageProvider,
  type StorageSaveContext,
  type StoredObject,
} from "./storageProvider.js";

/**
 * Local filesystem storage adapter used by `NODE_ENV=test` and
 * `DB_PROVIDER=sqlite`. Files are written under the uploads directory and
 * served statically at `/uploads/<key>` (mounted only when this provider is
 * active). Production never uses local disk.
 */
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly dir: string = config.uploadsDir) {}

  async save(
    buffer: Buffer,
    mimeType: string,
    originalName: string,
    context: StorageSaveContext,
  ): Promise<StoredObject> {
    fs.mkdirSync(this.dir, { recursive: true });
    const ext = path.extname(originalName).slice(0, 10) || "";
    const id = context.id ?? newId();
    const key = `${id}${ext}`;
    fs.writeFileSync(path.join(this.dir, key), buffer);
    return {
      id,
      objectKey: key,
      fileName: sanitizeFileName(originalName),
      mimeType,
      fileSize: buffer.byteLength,
      fileUrl: `${config.publicUrl}/uploads/${key}`,
    };
  }

  async remove(objectKey: string): Promise<void> {
    fs.rmSync(path.join(this.dir, path.basename(objectKey)), { force: true });
  }
}
