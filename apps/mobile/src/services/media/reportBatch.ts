import { photoToFile, type PickedPhoto } from "../photo";
import { computeSha256Hex, createHashRegistry, type PhotoHashRegistry } from "./dedupe";

/**
 * True for conversion failures photo.ts marks as safe to surface verbatim
 * (PhotoImportError: authored, actionable, path-free literals). A name check
 * rather than a class import keeps this working when screen tests mock the
 * photo module: anything else stays generic so private native URIs never leak.
 */
function isSafeConversionError(err: unknown): err is Error {
  return err instanceof Error && (err as { name?: string }).name === "PhotoImportError";
}

export { createHashRegistry } from "./dedupe";

export interface UnreadablePhoto {
  photo: PickedPhoto;
  /** Position of the failed selection within the input array (0-based). */
  index: number;
  /**
   * The actual conversion failure for PhotoImportErrors (safe, actionable,
   * path-free literals like the HEIC export guidance); a generic message for
   * anything else so private native URIs never leak into the interface.
   */
  reason: string;
}

export interface ReportBatchResult {
  accepted: PickedPhoto[];
  duplicates: PickedPhoto[];
  unreadable: UnreadablePhoto[];
  overflow: PickedPhoto[];
  notice: string;
}

/**
 * Process a picked batch of photos sequentially in selection order.
 * Returns accepted photos, duplicates, unreadable photos, overflow, and a notice string.
 * Capacity = 5 minus alreadySelectedCount.
 * One failure does NOT discard other accepted items.
 * Hash registry is updated synchronously within the batch loop.
 */
export async function processReportBatch(
  pickedPhotos: PickedPhoto[],
  alreadySelectedCount: number,
  existingHashRegistry?: PhotoHashRegistry,
  onAccepted?: (photo: PickedPhoto, file: File, hash: string) => void,
  /**
   * Offset of pickedPhotos[0] within the user's original selection. The
   * Report screen converts one native selection item at a time, so it passes
   * the selection position here to keep failure labels ("Photo 2") truthful.
   */
  indexBase = 0,
): Promise<ReportBatchResult> {
  const capacity = Math.max(0, 5 - alreadySelectedCount);
  const registry = existingHashRegistry ?? createHashRegistry();
  const accepted: PickedPhoto[] = [];
  const duplicates: PickedPhoto[] = [];
  const unreadable: UnreadablePhoto[] = [];
  const overflow: PickedPhoto[] = [];

  // Process in selection order, respecting capacity
  for (const [offset, photo] of pickedPhotos.entries()) {
    if (accepted.length >= capacity) {
      overflow.push(photo);
      continue;
    }

    const index = indexBase + offset;
    let file: File;
    try {
      file = await photoToFile(photo);
    } catch (err) {
      unreadable.push({
        photo,
        index,
        reason: isSafeConversionError(err) ? err.message : "Could not read the selected photo",
      });
      continue;
    }

    let hash: string;
    try {
      hash = await computeSha256Hex(file);
    } catch {
      unreadable.push({ photo, index, reason: "Could not compute file hash" });
      continue;
    }

    if (registry.has(hash)) {
      duplicates.push(photo);
      continue;
    }

    // Accept the photo: add hash to registry synchronously
    registry.add(hash);
    accepted.push(photo);
    onAccepted?.(photo, file, hash);
  }

  const notice = formatBatchNotice(accepted.length, duplicates.length, unreadable.length, overflow.length);
  return { accepted, duplicates, unreadable, overflow, notice };
}
/**
 * Build a notice like "2 photos added · 1 already selected · 1 unreadable".
 * Zero clauses are omitted; the empty string means "nothing happened".
 */
export function formatBatchNotice(
  added: number,
  duplicateCount: number,
  unreadableCount: number,
  overflowCount = 0,
): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} photo${added === 1 ? "" : "s"} added`);
  if (duplicateCount > 0) parts.push(`${duplicateCount} already selected`);
  if (unreadableCount > 0) parts.push(`${unreadableCount} unreadable`);
  if (overflowCount > 0) parts.push(`${overflowCount} over the 5 limit`);
  return parts.join(" · ");
}
