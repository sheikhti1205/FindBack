/**
 * URL acceptance for report writes, aligned with the deployed SQL helper in
 * 20260919000000_validation_alignment.sql. This server-aligned write policy is
 * separate from the strict HTTPS/origin validation used when rendering embeds.
 * Keep the server's supported watch?v= ordering; do not accept a reordered URL
 * here only to have the unchanged server refuse it after submission.
 */
export function isValidPostYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}/i.test(url.trim());
}
