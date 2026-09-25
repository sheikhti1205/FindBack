/**
 * Chat tray and report manifest built on imported images.
 *
 * Chat keeps up to 10 selections locally until the user explicitly sends; a
 * smaller per-model image limit is surfaced as a notice, never applied as a
 * silent truncation. Reports carry 0–5 ordered derivatives with explicit
 * display order. Animated inputs keep their animation in storage while the
 * disclosure states the assistant only sees sampled still frame(s).
 * Everything handed toward providers is id references — never bytes.
 */

import type { ImportedImage } from "./importImage";

export const MAX_CHAT_SELECTIONS = 10;
export const MAX_REPORT_PHOTOS = 5;

export const ANIMATED_FRAME_DISCLOSURE =
  "Animated photo: the full animation is kept in storage, but the assistant only sees " +
  "sampled still frame(s) — not every frame.";

export type PrepareErrorCode = "TRAY_FULL" | "REPORT_LIMIT" | "NOT_FOUND" | "BAD_INDEX";

export class PrepareError extends Error {
  readonly code: PrepareErrorCode;

  constructor(code: PrepareErrorCode, message: string) {
    super(message);
    this.name = "PrepareError";
    this.code = code;
  }
}

export interface ChatTray {
  items: readonly ImportedImage[];
}

export interface ChatSendPlan {
  retainedIds: readonly string[];
  sendIds: readonly string[];
  retainedCount: number;
  modelMaxImages?: number;
  capacityNotice: string | null;
}

export interface ReportEntry {
  imageId: string;
  displayOrder: number;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  animated: boolean;
  frameDisclosure: string | null;
}

export interface ReportManifest {
  entries: readonly ReportEntry[];
}

export function createChatTray(): ChatTray {
  return { items: [] };
}

export function addChatSelection(tray: ChatTray, item: ImportedImage): ChatTray {
  if (tray.items.some((existing) => existing.id === item.id)) {
    return tray;
  }
  if (tray.items.length >= MAX_CHAT_SELECTIONS) {
    throw new PrepareError(
      "TRAY_FULL",
      `Chat holds up to ${MAX_CHAT_SELECTIONS} photos until you send. ` +
        "This photo was not added and nothing was removed — take one out first.",
    );
  }
  return { items: [...tray.items, item] };
}

export function removeChatSelection(tray: ChatTray, id: string): ChatTray {
  const next = tray.items.filter((item) => item.id !== id);
  if (next.length === tray.items.length) {
    throw new PrepareError("NOT_FOUND", "That photo is not in the chat selection.");
  }
  return { items: next };
}

export function reorderChatSelection(tray: ChatTray, fromIndex: number, toIndex: number): ChatTray {
  const count = tray.items.length;
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= count ||
    toIndex < 0 ||
    toIndex >= count
  ) {
    throw new PrepareError("BAD_INDEX", "That reorder position is outside the chat selection.");
  }
  const next = [...tray.items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    throw new PrepareError("BAD_INDEX", "That reorder position is outside the chat selection.");
  }
  next.splice(toIndex, 0, moved);
  return { items: next };
}

/**
 * Plan a send without dropping anything: every retained selection stays in
 * both id lists. When the model accepts fewer images than retained, the notice
 * says so and the caller must offer a compatible model or approved batching.
 */
export function buildChatSendPlan(
  tray: ChatTray,
  options: { modelMaxImages?: number } = {},
): ChatSendPlan {
  const retainedIds = tray.items.map((item) => item.id);
  const limit = options.modelMaxImages;
  const knownLimit = typeof limit === "number" && Number.isFinite(limit) && limit >= 0;
  const capacityNotice =
    knownLimit && (limit as number) < retainedIds.length
      ? `This model accepts about ${limit} image(s) per request, but all ${retainedIds.length} ` +
        "selections are kept — nothing was dropped. Pick a model that takes more images, " +
        "or approve sending in smaller batches."
      : null;
  return {
    retainedIds,
    sendIds: [...retainedIds],
    retainedCount: retainedIds.length,
    ...(knownLimit ? { modelMaxImages: limit as number } : {}),
    capacityNotice,
  };
}

/** Sampled-frame disclosure for animated inputs; null for stills. */
export function frameDisclosureFor(image: ImportedImage): string | null {
  return image.animated ? ANIMATED_FRAME_DISCLOSURE : null;
}

function toReportEntry(image: ImportedImage, displayOrder: number): ReportEntry {
  return {
    imageId: image.id,
    displayOrder,
    mimeType: image.derivative.mimeType,
    width: image.derivative.width,
    height: image.derivative.height,
    byteLength: image.derivative.byteLength,
    animated: image.animated,
    frameDisclosure: frameDisclosureFor(image),
  };
}

export function buildReportManifest(images: readonly ImportedImage[]): ReportManifest {
  if (images.length > MAX_REPORT_PHOTOS) {
    throw new PrepareError(
      "REPORT_LIMIT",
      `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. ` +
        "The extra photo was not added — keep it for chat or remove one first.",
    );
  }
  return { entries: images.map((image, index) => toReportEntry(image, index)) };
}

export function reorderReportPhotos(
  manifest: ReportManifest,
  fromIndex: number,
  toIndex: number,
): ReportManifest {
  const count = manifest.entries.length;
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= count ||
    toIndex < 0 ||
    toIndex >= count
  ) {
    throw new PrepareError("BAD_INDEX", "That reorder position is outside the report photos.");
  }
  const images = [...manifest.entries];
  const [moved] = images.splice(fromIndex, 1);
  if (moved === undefined) {
    throw new PrepareError("BAD_INDEX", "That reorder position is outside the report photos.");
  }
  images.splice(toIndex, 0, moved);
  return { entries: images.map((entry, index) => ({ ...entry, displayOrder: index })) };
}

/** Opaque id references only — suitable for `approvedImageIds`, never bytes. */
export function toApprovedImageIds(images: readonly ImportedImage[]): string[] {
  return images.map((image) => image.id);
}
