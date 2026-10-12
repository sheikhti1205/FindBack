#!/usr/bin/env node
/**
 * Map provider build-config owner (FBX-027 — keyless MAP pivot reading).
 *
 * The audit finding predates the pivot ("Vite and Gradle can source Maps key
 * differently"): Vite loads root env files while the Gradle manifest path
 * reads process env only, so map JS and the native side could disagree. The
 * pivot removed the Google Maps/Places key entirely (see
 * scripts/check-map-provider.mjs, which fails the build if it reappears), but
 * the divergence shape survived: the two remaining map knobs —
 * FINDBACK_MAP_STYLE_URL (native BuildConfig.MAP_STYLE_URL) and
 * FINDBACK_MAP_CONTACT (native BuildConfig.MAP_SEARCH_CONTACT) — are read
 * ONLY by Gradle from process env, while the web layer never receives them
 * from the single root env source.
 *
 * This module is the ONE build-time owner for that config:
 *   - single source: the repo-root env (shell exports win, then root
 *     .env.production/.env — the same precedence every sibling gate uses);
 *   - Vite/web side: apps/mobile/vite.config.ts `resolveMapBuildEnv` resolves
 *     the same names/defaults and `define`s them into the bundle, and fails
 *     the web build through THIS script when a custom value is malformed;
 *   - Gradle/native side: app/build.gradle keeps reading the same env names
 *     with the same defaults (that file's map region is owned elsewhere), and
 *     `checkGradleMapSource` below fails when its names/defaults drift from
 *     this owner — divergence fails the build instead of shipping silently.
 *     The signeddev Gradle path (`verifySigneddevConfig`) runs
 *     check-signeddev-config.mjs, which includes this owner, so a direct
 *     `./gradlew assembleSigneddev` cannot bypass it either.
 *
 * Fail-closed semantics (mirrors the native MapValidation rules, which stay
 * the runtime backstop): an ABSENT custom value resolves to the
 * owner-decided default on both sides; a PRESENT-but-malformed custom value
 * FAILS the build — it never ships half-applied. There is no secret here
 * (public style endpoint + public contact), but logs still carry only
 * CUSTOM/DEFAULT presence — never values.
 *
 * Canonical local device-build command (M-c): `npm run apk -- --variant=signeddev`.
 * Actual signed-build execution stays deferred (no keystore in this environment).
 *
 * Pure Node builtins + vite/loadEnv (same as the sibling gates).
 * Test suite: scripts/check-map-config.test.mjs
 * Run: `node scripts/check-map-config.mjs` from repo root.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Root env names — the single source. Gradle reads these same names. */
export const MAP_STYLE_ENV = "FINDBACK_MAP_STYLE_URL";
export const MAP_CONTACT_ENV = "FINDBACK_MAP_CONTACT";
/** Owner-decided defaults — must equal the Gradle defaults (enforced below). */
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
export const DEFAULT_MAP_CONTACT = "https://findbackapp.social";
export const BUILD_GRADLE_PATH = resolve(root, "apps/mobile/android/app/build.gradle");

const PLACEHOLDER_RE = /(placeholder|changeme|your-|your_|example\.com|example\.org|example\.net)/i;

/**
 * Validate a style URL with the same rules the native side enforces
 * (MapValidation.validateStyleUrl): https, non-empty, non-placeholder, no
 * documentation hosts. Returns { ok, url } or { ok: false, reason }.
 */
export function validateMapStyleUrl(raw) {
  const url = (raw ?? "").trim();
  if (!url) return { ok: false, reason: "missing" };
  if (/[\s<>]/.test(url)) return { ok: false, reason: "malformed" };
  if (!url.toLowerCase().startsWith("https://")) return { ok: false, reason: "not-https" };
  const host = url.slice("https://".length).split("/", 1)[0].split(":", 1)[0].toLowerCase();
  if (!host) return { ok: false, reason: "malformed" };
  if (PLACEHOLDER_RE.test(url)) return { ok: false, reason: "placeholder" };
  return { ok: true, url };
}

/**
 * Validate the public search contact (Nominatim User-Agent contact). Lighter
 * than the style URL — non-blank, no whitespace, non-placeholder — because
 * the native side ships it verbatim in a User-Agent string, not as a fetch
 * target. Returns { ok, contact } or { ok: false, reason }.
 */
export function validateMapContact(raw) {
  const contact = (raw ?? "").trim();
  if (!contact) return { ok: false, reason: "missing" };
  if (/[\s<>]/.test(contact)) return { ok: false, reason: "malformed" };
  if (PLACEHOLDER_RE.test(contact)) return { ok: false, reason: "placeholder" };
  return { ok: true, contact };
}

/**
 * Resolve the effective map config both layers must agree on. Shell exports
 * win; otherwise the root env files are consulted. Injectable `env`/`envDir`
 * keep the resolution unit-testable; `loadEnv` still merges ambient
 * process.env (same rule as the sibling gates), so tests scrub the two
 * MAP_* keys for hermeticity.
 */
export function effectiveMapConfig({ env = process.env, envDir = root } = {}) {
  const fileEnv = loadEnv("production", envDir, "");
  const rawStyle = ((env[MAP_STYLE_ENV] ?? "").trim() || (fileEnv[MAP_STYLE_ENV] ?? "").trim()).trim();
  const rawContact = ((env[MAP_CONTACT_ENV] ?? "").trim() || (fileEnv[MAP_CONTACT_ENV] ?? "").trim()).trim();
  return {
    styleUrl: rawStyle || DEFAULT_MAP_STYLE_URL,
    contact: rawContact || DEFAULT_MAP_CONTACT,
    styleSource: rawStyle ? "custom" : "default",
    contactSource: rawContact ? "custom" : "default",
  };
}

/** CUSTOM when the owner supplied an override, else ABSENT — never a value. */
export function mapPresence(config) {
  return config.styleSource === "custom" || config.contactSource === "custom" ? "PRESENT" : "ABSENT";
}

/**
 * No-silent-divergence guard: app/build.gradle must read the same env names
 * with the same default literals this owner resolves. If either side changes
 * a name or default without the other, this fails the build. Injectable
 * `read` keeps it unit-testable without the repo tree.
 *
 * @returns {string[]} error messages (empty when the sources agree)
 */
export function checkGradleMapSource(read = readFileSync) {
  const errors = [];
  let text;
  try {
    text = read(BUILD_GRADLE_PATH, "utf8");
  } catch {
    return ["map build config unreadable (app/build.gradle)"];
  }
  for (const name of [MAP_STYLE_ENV, MAP_CONTACT_ENV]) {
    if (!text.includes(`System.getenv("${name}")`)) {
      errors.push(`app/build.gradle no longer reads ${name} (map config source diverged)`);
    }
  }
  for (const literal of [DEFAULT_MAP_STYLE_URL, DEFAULT_MAP_CONTACT]) {
    if (!text.includes(literal)) {
      errors.push(`app/build.gradle default diverged from the map config owner (${literal.length} chars, value withheld)`);
    }
  }
  return errors;
}

/**
 * Everything the map build truth must prove: custom values (when present)
 * are well-formed on BOTH sides' behalf, and Gradle still sources from this
 * owner. Absent custom values resolve to defaults — never a failure.
 */
export function checkMapConfig({ env = process.env, envDir = root, read = readFileSync } = {}) {
  const errors = [];
  const config = effectiveMapConfig({ env, envDir });
  if (config.styleSource === "custom") {
    const style = validateMapStyleUrl(config.styleUrl);
    if (!style.ok) errors.push(`${MAP_STYLE_ENV} ${style.reason} — refusing a custom style the native side would silently drop`);
  }
  if (config.contactSource === "custom") {
    const contact = validateMapContact(config.contact);
    if (!contact.ok) errors.push(`${MAP_CONTACT_ENV} ${contact.reason} — refusing a malformed public search contact`);
  }
  for (const error of checkGradleMapSource(read)) errors.push(error);
  return { ok: errors.length === 0, errors, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, errors, config } = checkMapConfig();
  if (!ok) {
    for (const error of errors) console.error(`check-map-config: ${error}`);
    console.error("check-map-config: FAIL");
    process.exit(1);
  }
  console.log(`check-map-config: PASS (style=${config.styleSource.toUpperCase()} contact=${config.contactSource.toUpperCase()})`);
}
