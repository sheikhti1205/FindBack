/**
 * URL acceptance for report writes, aligned with the deployed SQL helper in
 * 20260919000000_validation_alignment.sql. Extraction is NOT validation: the
 * shared best-effort extractor also recognizes YouTube-shaped text in a path.
 * Keep the server's supported watch?v= ordering; do not accept a reordered URL
 * here only to have the unchanged server refuse it after submission.
 */
export function isValidPostYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}/i.test(url.trim());
}
