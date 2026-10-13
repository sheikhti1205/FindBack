// Strict release configuration preflight (release.yml only — never CI).
//
// Fails closed when the Supabase client config baked into the web bundle is
// anything but a real publishable key for a reachable project:
//   * missing / empty URL or key
//   * placeholder values ("-", "xxx", "your-*", "placeholder", "changeme", "example", …)
//   * secret-shaped keys (sb_secret_* or service_role JWTs must never ship in a client bundle)
//   * non-https URLs or hosts outside *.supabase.co / *.supabase.in
//   * project auth health endpoint unreachable (wrong URL, not just wrong key)
//
// Google gate (SYNC-3/10/11): the release additionally requires a Web OAuth
// client ID (GOOGLE_WEB_CLIENT_ID present + *.apps.googleusercontent.com
// shape). Client-secret shapes (GOCSPX- secrets, embedded "secret" material,
// JSON blobs, tokens) are refused outright, and a client secret is NEVER
// required — its only legitimate home is the Supabase Google-provider
// dashboard, never the build environment. With `--apk <file>` the packaged
// artifact itself is inspected: BuildConfig must carry a non-empty Web client
// ID and no secret shapes (dex strings, presence only).
//
// Prints only lengths/shapes — never key material.
//
// Import-safe: importing this module runs nothing. Pure validators are
// exported for node --test; the CLI runs only when invoked directly.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
import { effectiveShareOrigin } from "./check-share-config.mjs";
import { effectiveGoogleConfig, validateGoogleClientId } from "./check-google-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PLACEHOLDER_RE = /^(-|x{2,}|your[-_].*|.*placeholder.*|changeme|example.*|.*example|test|dummy|null|undefined)$/i;

/** Env names that must NEVER carry a value in the build environment. Names only. */
export const GOOGLE_SECRET_ENV_NAMES = ["GOOGLE_CLIENT_SECRET", "GOOGLE_WEB_CLIENT_SECRET"];

/** Google OAuth client-secret prefix (and friends) — refused, never required. */
const GOOGLE_SECRET_VALUE_RE = /(^GOCSPX-)|secret|ya29\.|[{}]/i;

function fail(message) {
  console.error(`check-release-config: FAIL: ${message}`);
  process.exit(1);
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64").toString("utf8");
}

function isLikelySecretKey(key) {
  const trimmed = key.trim();
  if (trimmed.startsWith("sb_secret_")) return true;
  const parts = trimmed.split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(decodeBase64Url(parts[1])).role === "service_role";
  } catch {
    return false;
  }
}

/**
 * True when a GOOGLE_WEB_CLIENT_ID candidate looks like secret material:
 * an actual Google client-secret prefix, embedded secret text, a JSON blob,
 * pasted whitespace, or an OAuth access token. Legitimate Web client IDs are
 * `<digits>-<id>.apps.googleusercontent.com` (no whitespace, no braces).
 */
export function isSecretShapedGoogleValue(value) {
  const v = String(value ?? "").trim();
  if (!v) return false;
  return GOOGLE_SECRET_VALUE_RE.test(v) || /\s/.test(v);
}

/**
 * Hard Google gate for releases. Returns { ok, clientId } or
 * { ok: false, reason }. Reasons are constants; values never appear.
 * A client secret is never required: any secret-shaped candidate — or any
 * value at all in a GOOGLE_*_SECRET env var — fails closed.
 */
export function validateReleaseGoogleConfig({ clientId, env = process.env } = {}) {
  const secretHolder = GOOGLE_SECRET_ENV_NAMES.find((n) => (env[n] ?? "").trim() !== "");
  if (secretHolder) return { ok: false, reason: `client-secret-env:${secretHolder}` };
  const id = String(clientId ?? "").trim();
  if (!id) return { ok: false, reason: "missing" };
  if (isSecretShapedGoogleValue(id)) return { ok: false, reason: "secret-shaped" };
  const shape = validateGoogleClientId(id);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  return { ok: true, clientId: shape.clientId };
}

const defaultRun = (exe, args, opts) =>
  spawnSync(exe, args, { encoding: "utf8", ...opts });

/** Concatenated classes*.dex strings of an APK (ASCII needles survive MUTF-8). */
export function readApkDexText(apkPath, { run = defaultRun } = {}) {
  const listing = run("unzip", ["-Z", "-1", apkPath]);
  if (listing.status !== 0) throw new Error("cannot inspect APK (unzip -Z -1 failed)");
  const dexes = String(listing.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((n) => /^classes\d*\.dex$/.test(n));
  if (dexes.length === 0) throw new Error("no classes dex in APK");
  let text = "";
  for (const name of dexes) {
    const file = run("unzip", ["-p", apkPath, name], { maxBuffer: 64 * 1024 * 1024 });
    if (file.status !== 0) throw new Error("cannot read packaged dex");
    text += String(file.stdout ?? "");
  }
  return text;
}

/**
 * Packaged BuildConfig check: the dex must carry a non-empty Web client ID
 * (*.apps.googleusercontent.com) and no client-secret shapes. When the
 * expected clientId is given it must be the exact packaged value (no drift
 * between env and artifact). Reasons only — never values.
 */
export function checkPackagedGoogleText(dexText, { clientId } = {}) {
  const text = String(dexText ?? "");
  if (!text.includes(".apps.googleusercontent.com")) {
    return { ok: false, reason: "google-client-missing" };
  }
  if (/GOCSPX-/i.test(text)) return { ok: false, reason: "secret-shaped" };
  if (clientId && !text.includes(String(clientId))) return { ok: false, reason: "client-mismatch" };
  return { ok: true };
}

function isMainModule() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
  const key = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  try { effectiveShareOrigin(); } catch (error) { fail(error.message); }

  if (!url) fail("VITE_SUPABASE_URL is empty");
  if (!key) fail("VITE_SUPABASE_PUBLISHABLE_KEY is empty");
  if (PLACEHOLDER_RE.test(url) || PLACEHOLDER_RE.test(key)) {
    fail(`placeholder config detected (url_len=${url.length} key_len=${key.length})`);
  }
  if (isLikelySecretKey(key)) fail("publishable key looks like a SECRET key; refusing to bake it into the bundle");
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") fail(`Supabase URL must be https (got ${parsed.protocol})`);
    host = parsed.hostname;
  } catch {
    fail("VITE_SUPABASE_URL is not a valid URL");
  }
  if (!/\.supabase\.(co|in)$/.test(host)) fail(`Supabase host outside *.supabase.co/in (got ${host})`);

  // Sentry DSN is mandatory for installable builds. Resolved with Vite's own
  // loadEnv against apps/mobile — the SAME source `vite build` embeds into
  // import.meta.env (shell exports win over apps/mobile/.env* files). Shapes
  // only in logs, never key material.
  const sentry = checkEffectiveSentryDsn({ mode: "production" });
  if (!sentry.ok) fail(`VITE_SENTRY_DSN ${sentry.reason} (signed builds require a real https DSN)`);

  // Hard Google gate: a release must name its Web OAuth audience, and must
  // never accept (or require) client-secret material. FINDBACK_ENV_DIR isolates
  // the env-file root for hermetic tests; shell exports win over files. The
  // candidate is re-resolved here (shell first, then the effective file value)
  // so malformed vs missing vs secret-shaped keep their distinct reasons.
  const effective = effectiveGoogleConfig(process.env.FINDBACK_ENV_DIR || REPO_ROOT);
  const candidate =
    (process.env.GOOGLE_WEB_CLIENT_ID ?? "").trim() || (effective.ok ? effective.clientId : "");
  const gate = candidate
    ? validateReleaseGoogleConfig({ clientId: candidate })
    : { ok: false, reason: "missing" };
  if (!gate.ok) {
    fail(`GOOGLE_WEB_CLIENT_ID ${gate.reason} (release requires a Web OAuth client ID *.apps.googleusercontent.com; a client secret is never required here)`);
  }

  // Packaged artifact check: where this script verifies an artifact, prove the
  // BuildConfig value actually landed in it (non-empty) with no secret shapes.
  const apkFlag = process.argv.indexOf("--apk");
  if (apkFlag !== -1) {
    const apkPath = process.argv[apkFlag + 1];
    if (!apkPath) fail("--apk requires a path");
    let dex;
    try {
      dex = readApkDexText(apkPath);
    } catch (error) {
      fail(`cannot verify packaged Google config (${error.message})`);
    }
    const packaged = checkPackagedGoogleText(dex, { clientId: gate.clientId });
    if (!packaged.ok) {
      fail(`packaged GOOGLE_WEB_CLIENT_ID ${packaged.reason} (BuildConfig must carry the Web client ID, never a secret)`);
    }
    console.log("check-release-config: packaged Google config PASS (BuildConfig non-empty, no secret shapes)");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    // The key is sent ONLY as an authentication header to the project's own
    // health endpoint; neither URL nor key is ever printed (see fail/pass logs).
    res = await fetch(`${url}/auth/v1/health`, {
      signal: controller.signal,
      headers: { apikey: key },
    });
  } catch (err) {
    fail(`project unreachable at ${url}/auth/v1/health (${err.name})`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) fail(`/auth/v1/health returned ${res.status}; refusing to ship against this project`);

  console.log(`check-release-config: PASS (host=${host} key_len=${key.length})`);
  console.log(
    `check-release-config: Sentry DSN present (host=${sentry.host} project=${sentry.projectId} key_len=${sentry.keyLen})`,
  );
  console.log(`check-release-config: Google gate PASS (client_id_len=${gate.clientId.length})`);
}
