import type { PhotoPipelineOpts, PickedPhoto } from "../photo";
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
  /** True when an AbortSignal stopped the batch early; accepted items stay. */
  cancelled: boolean;
}

/** Per-photo progress for a batch conversion. */
export interface ReportBatchProgress {
  /** Settled items so far (accepted + duplicates + unreadable + overflow). */
  done: number;
  total: number;
  /** Human label for the item that just settled ("Photo 2"), never a native URI. */
  currentName: string;
}

export interface ProcessReportBatchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ReportBatchProgress) => void;
  /**
   * L-CONSOLIDATE: how one picked item becomes an uploadable File — REQUIRED.
   * The web lane passes its `photoToFile` bridge explicitly and the Android
   * report lane injects the canonical native processor, so a native failure
   * is surfaced as an unreadable item and NEVER falls back to fetching a
   * File/`webPath`. The old silent default (photoToFile) hid which lane a
   * batch ran on; omitting the seam now fails fast before any item runs.
   */
  convert: (photo: PickedPhoto, opts?: PhotoPipelineOpts) => Promise<File>;
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
  options?: ProcessReportBatchOptions,
): Promise<ReportBatchResult> {
  // L-CONSOLIDATE: the convert seam is required — no silent default lane.
  // Omitting it (or the whole options bag) fails fast here instead of
  // laundering every item into "unreadable" below.
  if (typeof options?.convert !== "function") {
    throw new Error("processReportBatch requires an explicit convert function");
  }
  const convert = options.convert;
  const capacity = Math.max(0, 5 - alreadySelectedCount);
  const registry = existingHashRegistry ?? createHashRegistry();
  const accepted: PickedPhoto[] = [];
  const duplicates: PickedPhoto[] = [];
  const unreadable: UnreadablePhoto[] = [];
  const overflow: PickedPhoto[] = [];
  const total = pickedPhotos.length;
  let cancelled = false;
  const reportProgress = (offset: number, index: number): void => {
    options.onProgress?.({ done: offset + 1, total, currentName: `Photo ${index + 1}` });
  };

  // Process in selection order, respecting capacity
  for (const [offset, photo] of pickedPhotos.entries()) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    const index = indexBase + offset;
    if (accepted.length >= capacity) {
      overflow.push(photo);
      reportProgress(offset, index);
      continue;
    }

    let file: File;
    try {
      file = await convert(photo, { signal: options.signal });
    } catch (err) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      unreadable.push({
        photo,
        index,
        reason: isSafeConversionError(err) ? err.message : "Could not read the selected photo",
      });
      reportProgress(offset, index);
      continue;
    }
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }

    let hash: string;
    try {
      hash = await computeSha256Hex(file, { signal: options.signal });
    } catch {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      unreadable.push({ photo, index, reason: "Could not compute file hash" });
      reportProgress(offset, index);
      continue;
    }
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }

    if (registry.has(hash)) {
      duplicates.push(photo);
      reportProgress(offset, index);
      continue;
    }

    // Accept the photo: add hash to registry synchronously
    registry.add(hash);
    accepted.push(photo);
    onAccepted?.(photo, file, hash);
    reportProgress(offset, index);
  }

  const notice = formatBatchNotice(accepted.length, duplicates.length, unreadable.length, overflow.length);
  return { accepted, duplicates, unreadable, overflow, notice, cancelled };
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
