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
      media.push({ kind: kindOfUrl(url), url, alt: "Attached photo" });
      continue;
    }
    const bare = BARE_URL_RE.exec(trimmed) ?? LINK_LINE_RE.exec(trimmed);
    const url = bare?.[1];
    if (url && kindOfUrl(url) === "video") {
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
 * is never base64 — only `https://` remote URLs are appended.
 */
export function appendBodyMedia(
  text: string,
  attachments: readonly { kind: "photo" | "video" | "gif"; remoteUrl: string; fileName?: string }[],
): string {
  const lines = [text.trim()].filter((s) => s !== "");
  for (const a of attachments) {
    const url = a.remoteUrl.trim();
    if (!/^https:\/\//i.test(url)) continue;
    if (a.kind === "video") lines.push(`[video](${url})`);
    else lines.push(`![${a.kind === "gif" ? "gif" : "photo"}](${url})`);
  }
  return lines.join("\n\n");
}

/** True when no `data:` URL anywhere in the body (base64 guard for tests). */
export function bodyHasInlineData(body: string): boolean {
  return /(^|[\s(])data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(body ?? "");
}
