import { MediaError, type TranscodeRequest } from "./importImage";

/** Browser-only seam: orient and downsample in the decode request, never an unbounded <img> fallback. */
export async function transcodeImageForWeb(request: TranscodeRequest): Promise<Uint8Array> {
  if (typeof createImageBitmap !== "function") {
    throw new MediaError("UNSUPPORTED_FORMAT", "This browser cannot safely prepare this photo. Try another browser or a smaller JPEG.");
  }
  const { targetWidth: width, targetHeight: height, mimeType, quality } = request;
  const sourceMime = `image/${request.sniffed.replace("-animated", "").replace("jpg", "jpeg")}`;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(request.bytes)], { type: sourceMime }), {
      imageOrientation: "from-image", resizeWidth: width, resizeHeight: height, resizeQuality: "high",
    });
  } catch {
    throw new MediaError("CORRUPT_IMAGE", "Couldn't read this photo. Try re-saving it as JPEG or PNG.");
  }
  try {
    let blob: Blob;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Photo preparation unavailable");
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type: mimeType, quality: quality ?? undefined });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Photo preparation unavailable");
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("Photo encoding failed")), mimeType, quality ?? undefined,
      ));
    }
    // Browsers may silently substitute PNG when an encoder is unsupported.
    if (blob.type && blob.type !== mimeType) throw new MediaError("UNSUPPORTED_FORMAT", "This browser cannot encode that photo format.");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
