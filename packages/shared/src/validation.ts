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

/** Extract an exact video ID only from supported HTTPS YouTube origins. */
export function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    let id: string | null;
    if (parsed.origin === "https://youtu.be") {
      id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1] ?? null;
    } else if (parsed.origin === "https://youtube.com" || parsed.origin === "https://www.youtube.com") {
      if (parsed.pathname === "/watch") {
        const ids = parsed.searchParams.getAll("v");
        id = ids.length === 1 ? ids[0]! : null;
      } else {
        id = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1] ?? null;
      }
    } else {
      return null;
    }
    return id !== null && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
