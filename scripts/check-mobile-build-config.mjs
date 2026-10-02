#!/usr/bin/env node
// Fail closed at three boundaries: before the web build, after Vite emits JS,
// and after Android packages that JS. Only public identifiers are printed.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
import { effectiveShareOrigin, checkShareChunks } from "./check-share-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const placeholder = /^(-|x{2,}|your[-_].*|.*placeholder.*|changeme|example.*|.*example|test|dummy|null|undefined)$/i;

function fail(message) {
  throw new Error(`check-mobile-build-config: ${message}`);
}

function isSecretKey(key) {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function effectiveSupabaseConfig(mode = "production", envDir = root) {
  // Same root envDir used by apps/mobile/vite.config.ts; exported env wins.
  const env = loadEnv(mode, envDir, "");
  // Local root .env uses canonical SUPABASE_* names; CI exports VITE_*.
  // Explicit nonempty VITE_* values win. Blank example-file entries must not
  // shadow configured canonical SUPABASE_* values in the same local .env.
  const url = (env.VITE_SUPABASE_URL?.trim() || env.SUPABASE_URL || "").trim();
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (!url || placeholder.test(url)) fail("VITE_SUPABASE_URL missing or placeholder");
  if (!key || placeholder.test(key)) fail("VITE_SUPABASE_PUBLISHABLE_KEY missing or placeholder");
  if (isSecretKey(key)) fail("VITE_SUPABASE_PUBLISHABLE_KEY is a secret key");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("VITE_SUPABASE_URL is invalid");
  }
  if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.(co|in)$/.test(parsed.hostname)
      || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    fail("VITE_SUPABASE_URL must be a bare https Supabase project URL");
  }
  return { url, key, host: parsed.hostname };
}

function checkJs(chunks, config, sentryHost, source) {
  if (chunks.length === 0) fail(`no JavaScript assets in ${source}`);
  const has = (text) => chunks.some((chunk) => chunk.includes(text));
  if (!has(config.url)) fail(`Supabase URL missing from ${source}`);
  if (!has(config.key)) fail(`Supabase publishable key missing from ${source}`);
  if (!has(sentryHost)) fail(`Sentry DSN host missing from ${source}`);
  checkShareChunks(chunks, effectiveShareOrigin());
}

export function checkAssetDirectory(path, config, sentryHost) {
  const files = readdirSync(path).filter((name) => name.endsWith(".js"));
  checkJs(files.map((name) => readFileSync(resolve(path, name), "utf8")), config, sentryHost, "assets");
}

export function checkApk(path, config, sentryHost) {
  // CI/Android Gradle runs on hosts with unzip; read the APK itself, not a
  // possibly different dist directory. No extraction or credential logging.
  const listing = spawnSync("unzip", ["-Z", "-1", path], { encoding: "utf8" });
  if (listing.status !== 0) fail("cannot inspect APK (unzip -Z -1 failed)");
  const files = listing.stdout.split("\n").filter((name) =>
    /^assets\/public\/assets\/[^/]+\.js$/.test(name));
  const chunks = files.map((name) => {
    const file = spawnSync("unzip", ["-p", path, name], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    if (file.status !== 0) fail("cannot inspect packaged JavaScript");
    return file.stdout;
  });
  checkJs(chunks, config, sentryHost, "APK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, path] = process.argv.slice(2);
    if (!["--preflight", "--assets", "--apk"].includes(action)) fail("expected --preflight, --assets PATH, or --apk PATH");
    const config = effectiveSupabaseConfig();
    effectiveShareOrigin();
    if (action !== "--preflight" && !path) fail(`${action} requires a path`);
    if (action !== "--preflight") {
      const sentry = checkEffectiveSentryDsn({ mode: "production" });
      if (!sentry.ok) fail(`VITE_SENTRY_DSN ${sentry.reason}`);
      if (action === "--assets") checkAssetDirectory(path, config, sentry.host);
      else checkApk(path, config, sentry.host);
    }
    console.log(`check-mobile-build-config: PASS (${action}; host=${config.host}; key_len=${config.key.length})`);
  } catch (error) {
    // Validation errors deliberately never contain credentials.
    console.error(/^(check-mobile-build-config:|share config:)/.test(error.message) ? error.message :
      "check-mobile-build-config: cannot read build assets");
    process.exitCode = 1;
  }
}
