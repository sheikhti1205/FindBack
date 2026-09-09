import type { ZodError } from "zod";

/** Flatten a ZodError into `{ fieldName: firstMessage }` for form display. */
export function toFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Best-effort normalize + validate a Bangladeshi phone into E.164 (+8801...). */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s-]/g, "");
  const match = /^(\+?88)?(01[3-9]\d{8})$/.exec(cleaned);
  if (!match) return null;
  return `+880${match[2]!.slice(1)}`;
}

/** Extract a video id from common YouTube URL shapes, or null. */
export function extractYouTubeId(url: string): string | null {
  if (!url) return null;
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(
      url,
    );
  return m ? m[1]! : null;
}
