import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { run, get } from "../db/index.js";
import { newId, nowIso } from "./helpers.js";
import type { Row } from "../db/index.js";

export interface StoredUpload {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileUrl: string;
}

export interface StorageProvider {
  save(buffer: Buffer, mimeType: string, originalName: string): Promise<StoredUpload>;
}

/**
 * Development storage adapter: files are written under services/api/uploads and
 * served statically at /uploads/<key>. The cloud adapter (Supabase Storage /
 * Firebase Storage / S3 / Cloudinary) is a drop-in replacement for this object.
 */
export const localStorageProvider: StorageProvider = {
  async save(buffer, mimeType, originalName) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const ext = path.extname(originalName).slice(0, 10) || "";
    const safeName = path.basename(originalName).replace(/[^\w.\- ]/g, "_").slice(0, 120);
    const id = newId();
    const key = `${id}${ext}`;
    fs.writeFileSync(path.join(config.uploadsDir, key), buffer);
    return {
      id,
      fileName: safeName,
      mimeType,
      fileSize: buffer.byteLength,
      fileUrl: `${config.publicUrl}/uploads/${key}`,
    };
  },
};

export async function recordUpload(
  userId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<StoredUpload> {
  const stored = await localStorageProvider.save(
    file.buffer,
    file.mimetype,
    file.originalname,
  );
  await run(
    `INSERT INTO uploads (id, user_id, file_name, mime_type, file_size, file_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [stored.id, userId, stored.fileName, stored.mimeType, stored.fileSize, stored.fileUrl, nowIso()],
  );
  return stored;
}

export function getUpload(id: string): Promise<Row | undefined> {
  return get<Row>("SELECT * FROM uploads WHERE id = ?", [id]);
}

export function randomIdForFile(): string {
  return crypto.randomBytes(16).toString("hex");
}
