import { readMotionXmp, type MotionXmp } from "./xmpMotion";
import { PROBE_BYTES } from "./mediaPolicy";

const headerOf = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes.subarray(0, PROBE_BYTES));
function number(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const result = Number(value); return Number.isSafeInteger(result) ? result : null;
}
function layout(metadata: MotionXmp, total: number): { stillEnd: number; videoStart: number; videoLength: number } | null {
  const items = metadata.items;
  const first = items[0];
  if (!first || first.semantic !== "Primary" || first.mime !== "image/jpeg" || number(first.length ?? "0") !== 0) return null;
  const padding = number(first.padding ?? "0");
  if (padding === null || padding > 65536) return null;
  if (items.filter((item) => item.semantic === "Primary").length !== 1 || items.filter((item) => item.semantic === "MotionPhoto").length !== 1 || items.at(-1)?.semantic !== "MotionPhoto") return null;
  const lengths: number[] = [];
  let tail = padding;
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const length = number(item.length);
    if (!item.mime || !item.semantic || item.padding !== null || length === null || length >= total) return null;
    lengths.push(length); tail += length;
    if (!Number.isSafeInteger(tail) || tail >= total) return null;
  }
  const stillEnd = total - tail;
  let cursor = stillEnd + padding;
  let resourceStart = 0; let resourceLength = stillEnd;
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]! > 0) { resourceStart = cursor; resourceLength = lengths[i]!; cursor += resourceLength; }
  }
  if (items.at(-1)?.mime !== "video/mp4" && items.at(-1)?.mime !== "video/quicktime") return null;
  if (resourceLength < 16 || resourceStart < stillEnd || resourceStart + resourceLength !== total) return null;
  return { stillEnd, videoStart: resourceStart, videoLength: resourceLength };
}
export function hasMotionPhotoMetadata(bytes: Uint8Array): boolean {
  const header = headerOf(bytes);
  try { const mode = readMotionXmp(header).mode; return mode === "modern" || mode === "legacy"; }
  catch { return /(?:MotionPhoto|MicroVideo)(?:\s*=|>)/.test(header); }
}
function validFtypWindow(window: Uint8Array, declaredLength: number): boolean {
  if (window.length !== 12) return false;
  const boxSize = new DataView(window.buffer, window.byteOffset, 4).getUint32(0);
  return boxSize >= 8 && boxSize <= declaredLength && String.fromCharCode(...window.subarray(4, 8)) === "ftyp";
}

/** Absolute [start, end) byte window the detector must read to decide. */
export type MotionPhotoWindow = readonly [start: number, end: number];

interface MotionPlanModern {
  kind: "modern";
  stillEnd: number;
  videoLength: number;
  /** Still EOI first, then the video resource's ftyp box — both tiny. */
  windows: readonly [MotionPhotoWindow, MotionPhotoWindow];
}
interface MotionPlanLegacy {
  kind: "legacy";
  scanStart: number;
  videoLength: number;
  /** Video ftyp box first, then the short EOI/padding scan band. */
  windows: readonly [MotionPhotoWindow, MotionPhotoWindow];
}
type MotionPlan = MotionPlanModern | MotionPlanLegacy;

/**
 * FBX-002: which absolute byte windows a Motion Photo container needs, from
 * its leading XMP header and declared length ALONE. Neither the still payload
 * nor the video tail is ever materialized: validation later reads two tiny
 * targeted windows (a 12-byte ftyp box and a ≤34-byte EOI band), so a 100 MB
 * container costs a few dozen bytes of JS, never 100 MB.
 */
function planMotionPhoto(header: Uint8Array, total: number): MotionPlan | null {
  if (total < 32 || header.length < 2 || header[0] !== 0xff || header[1] !== 0xd8) return null;
  let metadata: MotionXmp;
  try { metadata = readMotionXmp(new TextDecoder("latin1").decode(header.subarray(0, PROBE_BYTES))); } catch { return null; }
  if (metadata.mode === "none" || metadata.mode === "disabled") return null;
  if (metadata.mode === "modern") {
    const modern = layout(metadata, total);
    if (!modern || modern.stillEnd < 4 || modern.videoStart < 4) return null;
    return {
      kind: "modern",
      stillEnd: modern.stillEnd,
      videoLength: modern.videoLength,
      windows: [
        [modern.stillEnd - 2, modern.stillEnd],
        [modern.videoStart, modern.videoStart + 12],
      ],
    };
  }
  const length = number(metadata.offset);
  if (length === null || length < 16) return null;
  const start = total - length;
  if (start < 4) return null;
  return {
    kind: "legacy",
    scanStart: Math.max(2, start - 34),
    videoLength: length,
    windows: [
      [start, start + 12],
      [Math.max(2, start - 34), start],
    ],
  };
}

/** Validate the planned windows, in plan order. Pure; no I/O. */
function confirmMotionPhoto(plan: MotionPlan, windows: readonly Uint8Array[]): { stillEnd: number } | null {
  if (plan.kind === "modern") {
    const eoi = windows[0]!;
    const ftyp = windows[1]!;
    if (eoi.length !== 2 || eoi[0] !== 255 || eoi[1] !== 217) return null;
    if (!validFtypWindow(ftyp, plan.videoLength)) return null;
    return { stillEnd: plan.stillEnd };
  }
  const ftyp = windows[0]!;
  const scan = windows[1]!;
  if (!validFtypWindow(ftyp, plan.videoLength)) return null;
  for (let i = scan.length - 2; i >= 0; i--) {
    if (scan[i] === 255 && scan[i + 1] === 217 && scan.subarray(i + 2).every((value) => value === 0)) return { stillEnd: plan.scanStart + i + 2 };
  }
  return null;
}

/** Namespace-aware modern metadata is authoritative, including disabled values. */
export function detectMotionPhoto(bytes: Uint8Array): { stillEnd: number } | null {
  const plan = planMotionPhoto(bytes.subarray(0, Math.min(bytes.length, PROBE_BYTES)), bytes.length);
  if (!plan) return null;
  const windows = plan.windows.map(([start, end]) => bytes.subarray(start, Math.min(end, bytes.length)));
  return confirmMotionPhoto(plan, windows);
}

/**
 * FBX-002: the bounded-window twin of {@link detectMotionPhoto}. `header` is
 * the leading PROBE_BYTES window the caller already read for sniffing; `read`
 * fetches each planned window on demand. The source is never materialized, so
 * the same container decides identically on a 12-byte read budget.
 */
export async function detectMotionPhotoBounded(
  header: Uint8Array,
  total: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<{ stillEnd: number } | null> {
  const plan = planMotionPhoto(header, total);
  if (!plan) return null;
  const windows: Uint8Array[] = [];
  for (const [start, end] of plan.windows) windows.push(await read(start, Math.min(end, total)));
  return confirmMotionPhoto(plan, windows);
}
/** Top-level box walk only; never search image/video payload for a marker string. */
export function hasUnsupportedMotionContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (let boxes = 0; offset + 8 <= bytes.length && boxes < 512; boxes++) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "mpvd") return true; // Includes malformed mpvd: no uncertain platform decode.
    let size = view.getUint32(offset); let header = 8;
    if (size === 0) return false;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(extended); header = 16;
    }
    if (size < header || size > bytes.length - offset) return false;
    offset += size;
  }
  return false;
}
export function strippedVideoBytes(totalLength: number, stillEnd: number | null): number {
  if (stillEnd === null || !Number.isSafeInteger(totalLength) || !Number.isSafeInteger(stillEnd) || stillEnd < 0 || stillEnd > totalLength) return 0;
  return totalLength - stillEnd;
}
