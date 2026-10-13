/**
 * S3 — Sentry release identity (single source of truth for the SDK `release`).
 *
 * Format (pinned by `release.test.ts`):
 *
 *   findback-mobile@<apps/mobile package.json version>+<git rev-parse --short=12 HEAD>
 *
 * The release workflow computes the IDENTICAL string in shell and passes it to
 * `sentry-cli sourcemaps upload --release`, then greps the baked value back out
 * of `dist` — so SDK release === uploaded debug-info release for the same build
 * is proven by test AND by the build, never by assertion alone.
 *
 * INTERFACE FOR S2's `sentry.ts` (coordinator wiring — do NOT edit sentry.ts here):
 *
 *   import { resolveSentryRelease } from "./release";
 *   Sentry.init({
 *     ...,
 *     release: resolveSentryRelease(import.meta.env) ?? undefined,
 *     ...getSentryPrivacyDefaults(),
 *   });
 *
 * `VITE_SENTRY_RELEASE` needs no `define` in vite.config.ts: Vite auto-exposes
 * every `VITE_*` env var on `import.meta.env`. The release job exports it
 * alongside the DSN; local builds leave it unset and this module returns null
 * (the SDK then falls back to its default release — local-safe, no telemetry
 * without a DSN anyway per S1/S2).
 */

export const SENTRY_RELEASE_PREFIX = "findback-mobile";

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[0-9a-f]{12}$/i;
const PLACEHOLDER_RE =
  /^(placeholder|example|test|dummy|unknown|null|undefined|your[-_].*|changeme)$/i;

function isUsableVersion(version: string): boolean {
  const trimmed = version.trim();
  return (
    trimmed.length > 0 &&
    VERSION_RE.test(trimmed) &&
    !PLACEHOLDER_RE.test(trimmed)
  );
}

function isUsableSha(sha: string): boolean {
  const trimmed = sha.trim();
  return (
    trimmed.length > 0 && SHA_RE.test(trimmed) && !PLACEHOLDER_RE.test(trimmed)
  );
}

/**
 * Build the canonical release string. Throws on empty/placeholder/malformed
 * inputs (fail closed — never mint a release that cannot match the upload).
 */
export function buildSentryRelease(version: string, commitSha: string): string {
  if (!isUsableVersion(version)) {
    throw new Error(`buildSentryRelease: refusing bad version ${version}`);
  }
  if (!isUsableSha(commitSha)) {
    throw new Error(`buildSentryRelease: refusing bad commit sha ${commitSha}`);
  }
  return `${SENTRY_RELEASE_PREFIX}@${version.trim()}+${commitSha.trim()}`;
}

/** True only for the pinned `findback-mobile@version+sha` shape. */
export function isValidSentryRelease(value: string): boolean {
  const trimmed = value.trim();
  const match = new RegExp(
    `^${SENTRY_RELEASE_PREFIX}@(.+)\\+(.+)$`,
  ).exec(trimmed);
  if (!match) return false;
  const version = match[1];
  const sha = match[2];
  if (version === undefined || sha === undefined) return false;
  return isUsableVersion(version) && isUsableSha(sha);
}

/**
 * Resolve the release for `Sentry.init`. Returns the baked
 * `VITE_SENTRY_RELEASE` when it has the pinned shape, else null (caller passes
 * `undefined` through to the SDK default). Never throws, never invents one.
 */
export function resolveSentryRelease(env: {
  VITE_SENTRY_RELEASE?: string | undefined;
}): string | null {
  const raw = env.VITE_SENTRY_RELEASE;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && isValidSentryRelease(trimmed) ? trimmed : null;
}
