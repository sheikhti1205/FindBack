import { readMotionXmp, type MotionXmp } from "./xmpMotion";

const headerOf = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes.subarray(0, 65536));
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
function validFtyp(bytes: Uint8Array, start: number, length: number): boolean {
  if (start < 4 || start + 12 > bytes.length) return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset + start, 4).getUint32(0);
  return boxSize >= 8 && boxSize <= length && String.fromCharCode(...bytes.subarray(start + 4, start + 8)) === "ftyp";
}
/** Namespace-aware modern metadata is authoritative, including disabled values. */
export function detectMotionPhoto(bytes: Uint8Array): { stillEnd: number } | null {
  if (bytes.length < 32 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let metadata: MotionXmp;
  try { metadata = readMotionXmp(headerOf(bytes)); } catch { return null; }
  if (metadata.mode === "none" || metadata.mode === "disabled") return null;
  if (metadata.mode === "modern") {
    const modern = layout(metadata, bytes.length);
    if (!modern || modern.stillEnd < 4 || bytes[modern.stillEnd - 2] !== 255 || bytes[modern.stillEnd - 1] !== 217 || !validFtyp(bytes, modern.videoStart, modern.videoLength)) return null;
    return { stillEnd: modern.stillEnd };
  }
  const length = number(metadata.offset);
  if (length === null || length < 16) return null;
  const start = bytes.length - length;
  if (!validFtyp(bytes, start, length)) return null;
  for (let i = start - 2; i >= Math.max(2, start - 34); i--) {
    if (bytes[i] === 255 && bytes[i + 1] === 217 && bytes.subarray(i + 2, start).every((value) => value === 0)) return { stillEnd: i + 2 };
  }
  return null;
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
