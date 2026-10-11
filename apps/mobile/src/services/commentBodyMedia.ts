/**
 * C3 comment body media: attachments travel as `https://` remote URLs in the
 * comment body (Markdown image/link lines) — never base64. `MarkdownView`
 * strips remote images by policy, so `parseCommentBody` lifts those lines
 * back out for a dedicated gallery renderer while the remaining text keeps
 * the existing markdown path untouched.
 */

export const MAX_COMMENT_BODY = 1000;

export interface BodyMedia {
  kind: "photo" | "video";
  url: string;
  alt: string;
}

export interface ParsedCommentBody {
  /** Body with media lines removed (trimmed). Render through MarkdownView. */
  text: string;
  /** Media in appearance order. Render as a gallery below the text. */
  media: BodyMedia[];
}

const IMAGE_LINE_RE = /^!\[[^\]]*\]\((https:\/\/[^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const LINK_LINE_RE = /^\[[^\]]*\]\((https:\/\/[^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const BARE_URL_RE = /^(https:\/\/\S+)$/;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?[^#\s]*)?(#[^\s]*)?$/i;

/**
 * Where a media URL may come from (FBX-014 provenance).
 *
 * - `storage`: this deployment's Supabase Storage public-object URLs, path
 *   marker `/storage/v1/object/public/`, an allowlisted media bucket, and an
 *   owner segment — the shape every upload path in `commentAttachments`
 *   produces (legacy report-bucket comment media stays readable).
 * - `klipy`: the GIF/sticker provider (`klipy.com` / `*.klipy.com`).
 *
 * Everything else — any other host, `http:`, `data:`, unknown bucket, or a
 * marker that merely appears inside a foreign URL (substring attack) — is
 * untrusted and must stay inert text.
 */
export type CommentMediaProvenance = "storage" | "klipy";

/** Buckets whose objects may render in the comment gallery. */
const COMMENT_MEDIA_BUCKETS = new Set(["findback-comment-media", "findback-images"]);
const STORAGE_PUBLIC_MARKER = "/storage/v1/object/public/";

/**
 * Classify a URL's provenance. Pure and total: never throws, returns null
 * for anything that is not trusted comment media. Enforced on parse (an
 * untrusted line never becomes gallery media) and on append (the write side
 * refuses to emit it in the first place).
 */
export function commentMediaProvenance(url: string): CommentMediaProvenance | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "klipy.com" || host.endsWith(".klipy.com")) return "klipy";
  if (!host.endsWith(".supabase.co")) return null;
  // Single-label project ref only: `evil.supabase.co.evil.com` and
  // `a.b.supabase.co` never reach the path checks.
  const projectRef = host.slice(0, -".supabase.co".length);
  if (projectRef === "" || projectRef.includes(".")) return null;
  const path = parsed.pathname;
  // Exact path PREFIX (position 0): a marker buried in a foreign path or
  // query/fragment never counts.
  if (!path.startsWith(STORAGE_PUBLIC_MARKER)) return null;
  const rest = path.slice(STORAGE_PUBLIC_MARKER.length);
  const bucketEnd = rest.indexOf("/");
  if (bucketEnd <= 0) return null;
  if (!COMMENT_MEDIA_BUCKETS.has(rest.slice(0, bucketEnd))) return null;
  // Owner segment + object: `<bucket>/<owner>/<object>` — a flat
  // `<bucket>/<file>` has no owner and is rejected.
  const ownerStart = bucketEnd + 1;
  const objectStart = rest.indexOf("/", ownerStart);
  if (objectStart <= ownerStart) return null;
  if (rest.slice(objectStart + 1).length === 0) return null;
  return "storage";
}

function kindOfUrl(url: string): "photo" | "video" {
  return VIDEO_EXT_RE.test(url) ? "video" : "photo";
}

/** Split a comment body into renderable text + gallery media. Never throws. */
export function parseCommentBody(body: string): ParsedCommentBody {
  const media: BodyMedia[] = [];
  const kept: string[] = [];
  for (const line of (body ?? "").split("\n")) {
    const trimmed = line.trim();
    const image = IMAGE_LINE_RE.exec(trimmed);
    if (image?.[1]) {
      const url = image[1];
      // Provenance gate: an untrusted host in image-markdown form is the
      // pasted-Markdown attack shape — keep it as inert text instead.
      if (commentMediaProvenance(url)) {
        media.push({ kind: kindOfUrl(url), url, alt: "Attached photo" });
        continue;
      }
      kept.push(line);
      continue;
    }
    const bare = BARE_URL_RE.exec(trimmed) ?? LINK_LINE_RE.exec(trimmed);
    const url = bare?.[1];
    if (url && commentMediaProvenance(url) && kindOfUrl(url) === "video") {
      media.push({ kind: "video", url, alt: "Attached video" });
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trim(), media };
}

/**
 * Append uploaded attachments as media lines. Photos/gifs become
 * `![photo](url)` lines; videos become `[video](url)` lines. The text itself
 * is never base64 — only trusted `https://` provenance-checked URLs are
 * appended (write-side guard: an untrusted URL is dropped, not emitted).
 */
export function appendBodyMedia(
  text: string,
  attachments: readonly { kind: "photo" | "video" | "gif"; remoteUrl: string; fileName?: string }[],
): string {
  const lines = [text.trim()].filter((s) => s !== "");
  for (const a of attachments) {
    const url = a.remoteUrl.trim();
    if (!/^https:\/\//i.test(url)) continue;
    if (!commentMediaProvenance(url)) continue;
    if (a.kind === "video") lines.push(`[video](${url})`);
    else lines.push(`![${a.kind === "gif" ? "gif" : "photo"}](${url})`);
  }
  return lines.join("\n\n");
}

/** True when no `data:` URL anywhere in the body (base64 guard for tests). */
export function bodyHasInlineData(body: string): boolean {
  return /(^|[\s(])data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(body ?? "");
}
