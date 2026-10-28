/** Shared enforcement at the history boundary, never a caller's verified flag. */
import { probeDimensions, sniffImage } from "../media/importImage";
import { transcodeImageForWeb } from "../media/webTranscode";
import { verifyMediaBytes, type MediaMetadata } from "./media";
import { sniffMediaMime } from "./validation";

/** Platform decoder port; tests replace decoding, not metadata/hash checks. */
export type MediaDecoder = (bytes: ArrayBuffer, metadata: MediaMetadata) => Promise<void>;

const decodeMedia: MediaDecoder = async (bytes, metadata) => {
  // Reuse canonical bounded decoding. The tiny derivative is discarded; the
  // immutable original is stored only if the platform could actually decode it.
  await transcodeImageForWeb({ bytes: new Uint8Array(bytes),
    sniffed: metadata.mime === "image/jpeg" ? "jpeg" : metadata.mime === "image/png" ? "png" : "webp",
    targetWidth: 1, targetHeight: 1, mimeType: "image/png", quality: null });
};

/** Transport verifies assertions; durable admission additionally requires decoding. */
export async function verifyMediaContainer(metadata: MediaMetadata, bytes: ArrayBuffer): Promise<void> {
  await verifyMediaBytes(metadata, bytes);
  if (sniffMediaMime(bytes) !== metadata.mime) throw new Error("Media type mismatch");
  const view = new Uint8Array(bytes);
  const kind = sniffImage(view);
  if (kind !== "jpeg" && kind !== "png" && kind !== "webp") throw new Error("Media must be a supported still image");
  const size = probeDimensions(view, kind);
  if (!size || size.width !== metadata.width || size.height !== metadata.height) {
    throw new Error("Media dimension mismatch");
  }
}

export async function verifyMediaContent(
  metadata: MediaMetadata, bytes: ArrayBuffer, decode: MediaDecoder = decodeMedia,
): Promise<void> {
  await verifyMediaContainer(metadata, bytes);
  await decode(bytes, metadata);
}
