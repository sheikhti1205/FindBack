#!/usr/bin/env node
/**
 * Sentry DSN preflight for installable builds (S1).
 *
 * Owner rule: every installable APK (CI build, signed release, local
 * `npm run apk`) MUST embed a real Sentry DSN. Unit tests and `vite dev`
 * stay DSN-free with monitoring inert.
 *
 * Local env contract (verified against Vite docs + vite.config.ts):
 * - `apps/mobile` code reads the DSN via `import.meta.env.VITE_SENTRY_DSN`,
 *   whose envDir is `apps/mobile/`. Effective value = shell-exported
 *   `VITE_SENTRY_DSN` (highest precedence, never overwritten) over
 *   `apps/mobile/.env*` files. A `VITE_SENTRY_DSN` in the REPO-ROOT `.env`
 *   is NOT embedded (root .env only feeds the Supabase `define`s).
 * - This helper resolves the DSN with Vite's own `loadEnv(mode, mobileDir)`,
 *   i.e. the SAME source Vite embeds — never a different approximation.
 *
 * Prints only shapes (host, lengths) — never key material.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "vite";

export const SENTRY_DSN_PATTERN_HINT = "https://<key>@<host>/<project-id>";

// Mirrors scripts/check-release-config.mjs placeholder policy, applied per
// DSN component (key, host, project id) to avoid substring false positives.
const PLACEHOLDER_RE =
  /^(-|x{2,}|your[-_].*|.*placeholder.*|changeme|example.*|.*example|test|dummy|null|undefined)$/i;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MOBILE_DIR = resolve(REPO_ROOT, "apps/mobile");

/**
 * Validate a Sentry DSN string. Returns shapes only, never the key.
 * ok:true  -> { ok, host, projectId, keyLen }
 * ok:false -> { ok, reason: "missing" | "malformed" | "placeholder" }
 */
export function validateSentryDsn(raw) {
  if (raw === undefined || raw === null) return { ok: false, reason: "missing" };
  const trimmed = String(raw).trim();
  if (!trimmed) return { ok: false, reason: "missing" };
  if (!trimmed.startsWith("https://")) return { ok: false, reason: "malformed" };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const key = parsed.username;
  const host = parsed.hostname;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const projectId = segments.length ? segments[segments.length - 1] : "";
  if (!key || !host || !projectId) return { ok: false, reason: "malformed" };
  if (PLACEHOLDER_RE.test(key) || PLACEHOLDER_RE.test(host) || PLACEHOLDER_RE.test(projectId)) {
    return { ok: false, reason: "placeholder" };
  }
  return { ok: true, host, projectId, keyLen: key.length };
}

/**
 * Load the effective VITE_SENTRY_DSN exactly as Vite will embed it into
 * `import.meta.env` for the mobile app: `loadEnv(mode, apps/mobile)` merges
 * apps/mobile/.env* files with shell exports (shell wins). Returns undefined
 * when no source provides one.
 */
export function loadSentryFileEnv(mode = "production", mobileDir = MOBILE_DIR) {
  const env = loadEnv(mode, mobileDir, "VITE_");
  return env.VITE_SENTRY_DSN;
}

/** Resolve + validate in one step for preflight callers. */
export function checkEffectiveSentryDsn({ mode = "production", mobileDir = MOBILE_DIR } = {}) {
  return validateSentryDsn(loadSentryFileEnv(mode, mobileDir));
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const modeFlag = process.argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeFlag ? modeFlag.slice("--mode=".length) : "production";
  const result = checkEffectiveSentryDsn({ mode });
  if (!result.ok) {
    console.error(
      `check-sentry-config: FAIL: VITE_SENTRY_DSN ${result.reason} ` +
        `(expected ${SENTRY_DSN_PATTERN_HINT}; set a repo Actions variable or export it locally)`,
    );
    process.exit(1);
  }
  console.log(
    `check-sentry-config: PASS (host=${result.host} project=${result.projectId} key_len=${result.keyLen})`,
  );
}
