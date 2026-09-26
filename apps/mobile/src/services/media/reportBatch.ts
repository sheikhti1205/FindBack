import { photoToFile, type PickedPhoto } from "../photo";
import { computeSha256Hex, createHashRegistry, type PhotoHashRegistry } from "./dedupe";

export { createHashRegistry } from "./dedupe";

export interface UnreadablePhoto {
  photo: PickedPhoto;
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
): Promise<ReportBatchResult> {
  const capacity = Math.max(0, 5 - alreadySelectedCount);
  const registry = existingHashRegistry ?? createHashRegistry();
  const accepted: PickedPhoto[] = [];
  const duplicates: PickedPhoto[] = [];
  const unreadable: UnreadablePhoto[] = [];
  const overflow: PickedPhoto[] = [];

  // Process in selection order, respecting capacity
  for (const photo of pickedPhotos) {
    if (accepted.length >= capacity) {
      overflow.push(photo);
      continue;
    }

    let file: File;
    try {
      file = await photoToFile(photo);
    } catch {
      unreadable.push({ photo, reason: "Could not read file" });
      continue;
    }

    let hash: string;
    try {
      hash = await computeSha256Hex(file);
    } catch {
      unreadable.push({ photo, reason: "Could not compute file hash" });
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
