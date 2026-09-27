/** Detect an XMP-declared trailing MP4 only when the declared offset and JPEG boundary agree. */
export function detectMotionPhoto(bytes: Uint8Array): { stillEnd: number } | null {
  if (bytes.length < 32 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // XMP lives in JPEG header segments. Do not decode or stringify the photo/video payload.
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  if (!/GCamera:MicroVideo="1"/.test(header)) return null;
  const offset = /GCamera:MicroVideoOffset="(\d+)"/.exec(header);
  if (!offset) return null;
  const length = Number(offset[1]);
  const mp4Start = bytes.length - length;
  if (!Number.isSafeInteger(length) || length < 16 || mp4Start < 4 || mp4Start + 12 > bytes.length) return null;
  if (String.fromCharCode(...bytes.subarray(mp4Start + 4, mp4Start + 8)) !== "ftyp") return null;
  // Xiaomi/Google encoders can insert a short zero pad before the MP4 box.
  for (let i = mp4Start - 2; i >= Math.max(2, mp4Start - 34); i -= 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9 &&
        bytes.subarray(i + 2, mp4Start).every((byte) => byte === 0)) {
      return { stillEnd: i + 2 };
    }
  }
  return null;
}
