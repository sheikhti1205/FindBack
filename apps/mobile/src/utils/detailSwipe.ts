/**
 * Shared swipe decision for the detail hero gallery and the photo lightbox.
 *
 * Thresholds (documented for QA handoff):
 * - DETAIL_SWIPE_MIN_OFFSET_PX = 48: a drag shorter than this is accidental
 *   unless the flick velocity passes.
 * - DETAIL_SWIPE_MIN_VELOCITY_PX_S = 400: a fast flick advances even when the
 *   offset is short.
 * - Horizontal dominance: |offsetX| must strictly exceed |offsetY|, otherwise
 *   the gesture belongs to vertical page scroll and is ignored.
 */

export const DETAIL_SWIPE_MIN_OFFSET_PX = 48;
export const DETAIL_SWIPE_MIN_VELOCITY_PX_S = 400;

export type HorizontalSwipe = "next" | "prev";

export function resolveHorizontalSwipe(
  offsetX: number,
  offsetY: number,
  velocityX: number,
): HorizontalSwipe | null {
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(velocityX)) {
    return null;
  }
  // Vertical-dominant (or equal) gestures scroll the page, never the photo.
  if (Math.abs(offsetX) <= Math.abs(offsetY)) return null;
  // Small accidental drags: need either enough travel or enough flick speed.
  if (
    Math.abs(offsetX) < DETAIL_SWIPE_MIN_OFFSET_PX &&
    Math.abs(velocityX) < DETAIL_SWIPE_MIN_VELOCITY_PX_S
  ) {
    return null;
  }
  return offsetX < 0 ? "next" : "prev";
}
