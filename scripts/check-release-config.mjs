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
// Prints only lengths/shapes — never key material.

import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
const PLACEHOLDER_RE = /^(-|x{2,}|your[-_].*|.*placeholder.*|changeme|example.*|.*example|test|dummy|null|undefined)$/i;

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

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const key = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

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
