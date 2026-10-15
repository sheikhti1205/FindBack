/**
 * Display dimensions: a hint, never a rule (CF-060 M1 + REVIEW-M1 F4/F5).
 *
 * Report photos carry their intrinsic size so the feed can lay out a
 * natural-ratio masonry grid without waiting for the image to load. That is all
 * the value is for. Two consequences follow, and both are enforced here:
 *
 * - **Unknown is a normal state, not an error.** A row published before
 *   migration `20261015154642`, an image whose header could not be probed, or a
 *   value outside the vouchable range all read as "unknown", and callers fall
 *   back to a default ratio. A half-known pair is treated as unknown too: one
 *   dimension cannot produce a ratio, and presenting it as one would reserve the
 *   wrong space.
 * - **A hint may never block a publish.** The database checks are a sanity
 *   ceiling for garbage written by a non-client writer, not a rule about what a
 *   user may upload. `MAX_DISPLAY_DIMENSION` mirrors that ceiling
 *   (`uploads_dims_check` / `attachments_dims_check`), and the staging writer
 *   stores NULL rather than a value it cannot vouch for — a large animated GIF,
 *   which the media pipeline deliberately passes through untouched, must still
 *   publish.
 *
 * Bounds and shape are checked strictly, quiet coercion included: `"0x10"` is
 * not 16, `"1e3"` is not 1000, and `12.5` is not 12. Only a plain decimal
 * integer — as a number, or as the digit string a mirrored/offline row can
 * carry — is accepted.
 */

/** Sanity ceiling for a stored dimension. Mirrors the two dims checks. */
export const MAX_DISPLAY_DIMENSION = 100000;

/**
 * Sanity floor for a stored dimension. Mirrors the two dims checks too: zero is
 * "unknown", never "a size", so a stored 0 is not a vouchable dimension. The
 * floor is a named constant for the same reason as the ceiling - the SQL and the
 * client must not be able to drift apart unnoticed.
 */
export const MIN_DISPLAY_DIMENSION = 1;

/**
 * A vouchable dimension, or null for "unknown".
 *
 * Null means the caller must fall back to a default ratio. It never means zero
 * and it is never used to size a box.
 */
export function displayDimensionOrNull(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : NaN;
  return Number.isInteger(n) && n >= MIN_DISPLAY_DIMENSION && n <= MAX_DISPLAY_DIMENSION ? n : null;
}

/**
 * The intrinsic size as a complete pair, or null.
 *
 * Pair-or-nothing (CF-060 M1): media with a half-known size reports no size at
 * all, so no caller can accidentally reserve space from one axis.
 */
export function displaySizeOrNull(input: {
  readonly width?: unknown;
  readonly height?: unknown;
}): { readonly width: number; readonly height: number } | null {
  const width = displayDimensionOrNull(input.width);
  const height = displayDimensionOrNull(input.height);
  return width !== null && height !== null ? { width, height } : null;
}
