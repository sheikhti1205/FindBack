/**
 * Single semantic source-acceptance policy for every FindBack photo path.
 *
 * The JS intake path (`photo.ts`, `importImage.ts`) and the Android native
 * processor (`com.findback.app.media.MediaPolicy`) enforce the SAME source
 * cap and the SAME user-facing copy. Derivative caps are separate concerns:
 * they are applied AFTER preparation and never inherit from the source cap.
 *
 * Cross-language parity is covered by `mediaPolicy.test.ts` (JS) and
 * `MediaPolicyTest` / `MediaStreamsTest` (JVM): 99 MiB reaches preparation,
 * 100 MiB + 1 is refused before any decode or source-sized allocation.
 */

/** Semantic source cap: 100 MiB. Not a user-facing resolution/megapixel cap. */
export const SOURCE_MAX_BYTES = 100 * 1024 * 1024;

/** Shared copy, mirrored by MediaPolicy.sourceLimitMessage() on the native side. */
export const SOURCE_LIMIT_MESSAGE =
  "That photo is over the 100 MB source limit and can't be prepared on this device. Choose a smaller image.";

/** Longest-edge downsample target for the bounded derivative. */
export const MAX_EDGE = 1920;

/** Native compressor ceiling per derivative (MediaPolicy.MAX_DERIVATIVE_BYTES). */
export const MAX_DERIVATIVE_BYTES = 2_000_000;

/** Transport ceiling applied to the prepared derivative before upload. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bytes read when probing a source for magic bytes / header dimensions.
 * Header work NEVER reads the whole source.
 */
export const PROBE_BYTES = 65_536;

/**
 * FBX-003: the ONE advertised accepted-container list. Every intake path
 * advertises this exact set (photo.ts rejection copy, importImage.ts
 * rejection copy) and every accept map is checked against it, so the
 * advertisement and the enforcement can never drift apart again.
 *
 * Order matches the user-facing sentence: raster stills first, then the
 * modern containers that normalize through the shared decode policy.
 */
export const ACCEPTED_STILL_FORMATS_LABEL = "JPEG, PNG, WebP, GIF, BMP, HEIC, HEIF, or AVIF";

/** True when a source length is inside the single source cap. */
export function isWithinSourceCap(byteLength: number): boolean {
  return Number.isFinite(byteLength) && byteLength >= 0 && byteLength <= SOURCE_MAX_BYTES;
}
