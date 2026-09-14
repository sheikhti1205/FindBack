import sharp from "sharp";

export interface NormalizedImage {
  buffer: Buffer;
  /** MIME type of the bytes actually returned (may differ after transcoding). */
  mimeType: string;
}

const MAX_EDGE = 1920;
const JPEG_QUALITY = 82;
const WEBP_QUALITY = 82;

/**
 * Normalize an uploaded image before it is stored, so raw phone-camera files do
 * not needlessly consume Storage quota:
 *
 * - EXIF orientation is applied (`.rotate()` with no angle);
 * - the longest edge is capped at 1920px, never enlarging a smaller image;
 * - the bytes are re-encoded at a sensible web/mobile quality;
 * - animated GIFs are returned byte-for-byte unchanged because sharp cannot
 *   safely round-trip their animation.
 *
 * `mimeType` always reflects the returned bytes. Throws on undecodable input
 * (the caller maps that to a 400).
 */
export async function normalizeImage(
  buffer: Buffer,
  mimeType: string,
): Promise<NormalizedImage> {
  if (mimeType === "image/gif") {
    // Static and animated GIFs are stored as-is to avoid destroying animation.
    return { buffer, mimeType: "image/gif" };
  }

  const pipeline = sharp(buffer, { animated: false }).rotate().resize({
    width: MAX_EDGE,
    height: MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });

  if (mimeType === "image/png") {
    return { buffer: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mimeType: "image/png" };
  }
  if (mimeType === "image/webp") {
    return { buffer: await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer(), mimeType: "image/webp" };
  }
  // image/jpeg and image/jpg.
  return {
    buffer: await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer(),
    mimeType: "image/jpeg",
  };
}
