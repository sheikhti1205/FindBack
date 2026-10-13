#!/usr/bin/env node
/**
 * Cross-platform Android APK build for the Supabase-native app (Block 10K).
 *
 * Usage: set VITE_SENTRY_DSN for installable builds and either export
 * VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY or use the canonical
 * SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY in the ignored root .env.
 * Then run `npm run apk`.
 *
 * Only the public Supabase URL + publishable key are baked into the bundle. No
 * API base URL is needed — the app talks exclusively to hosted Supabase (Auth /
 * Data API / Realtime / Storage / Edge Functions). The secret key must never be
 * provided here.
 *
 * Sentry is MANDATORY for installable builds: the preflight below fails closed
 * when no real VITE_SENTRY_DSN is visible. Local env contract: the DSN is
 * embedded from shell exports (highest precedence) or apps/mobile/.env* files
 * (import.meta.env, envDir apps/mobile). A VITE_SENTRY_DSN in the repo-root
 * .env is NOT embedded — root .env only feeds the Supabase `define`s.
 *
 * Release identity (SYNC-3/10/11): every local build derives
 *   VITE_SENTRY_RELEASE=findback-mobile@<version>+<short12>
 * (version from apps/mobile/package.json, SHA from `git rev-parse --short=12
 * HEAD`) plus a deliberate per-variant environment
 * (local-debug/local-signeddev/local-release via VITE_SENTRY_ENVIRONMENT), and
 * the built bundle is verified to contain the Sentry DSN host AND the release
 * identity (presence only — values are never printed).
 *
 * Symbol upload (FINDBACK_SENTRY_UPLOAD=true): requires SENTRY_AUTH_TOKEN /
 * SENTRY_ORG / SENTRY_PROJECT (fail closed listing missing NAMES only), builds
 * with hidden sourcemaps, uploads with the EXACT same release the bundle
 * carries, verifies the upload, deletes every *.map, proves none remain, and
 * only then packages. Without the opt-in the build emits no maps at all and
 * prints SENTRY_SYMBOLICATION=NOT_UPLOADED (never claims symbolicated).
 *
 * Push (FCM): signeddev/release builds materialize the Firebase Android client
 * config via scripts/materialize-google-services.mjs (GOOGLE_SERVICES_JSON_B64
 * path) or accept an already-present, validated, gitignored
 * apps/mobile/android/app/google-services.json. A push-required build without
 * a valid client config fails closed; debug allows a documented FCM-disabled
 * mode. Wrong package/project or service-account-shaped JSON is refused by the
 * materializer and its errors are surfaced (never swallowed).
 *
 * Import-safe: importing this module runs nothing. All behavior is exported
 * pure/injectable functions for node --test; the CLI runs only when invoked
 * directly. Logs carry presence/shapes only — never key material.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";
import { effectiveGoogleConfig } from "./check-google-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MOBILE_PKG_PATH = resolve(REPO_ROOT, "apps/mobile/package.json");
const MOBILE_DIST_DIR = resolve(REPO_ROOT, "apps/mobile/dist");
const MOBILE_ASSETS_DIR = resolve(MOBILE_DIST_DIR, "assets");
const GOOGLE_SERVICES_PATH = resolve(
  REPO_ROOT,
  "apps/mobile/android/app/google-services.json",
);
const MATERIALIZER = resolve(HERE, "materialize-google-services.mjs");

export const VARIANTS = {
  debug: "apk",
  signeddev: "apk:signeddev",
  release: "apk:release",
};

/** Deliberate Sentry environment per local variant (never the Vite default). */
export const ENVIRONMENT_FOR_VARIANT = {
  debug: "local-debug",
  signeddev: "local-signeddev",
  release: "local-release",
};

/** Same release-identity shape CI mints (release.yml "Compute Sentry release identity"). */
export const SENTRY_RELEASE_RE =
  /^findback-mobile@\d+\.\d+\.\d+[-+0-9A-Za-z.]*\+[0-9a-f]{7,40}$/i;

/** Exact sentry-cli pin used for symbol upload (matches release.yml M5). */
export const SENTRY_CLI_PIN = "@sentry/cli@3.8.0";

/** Firebase Android client expectations (mirrors materialize-google-services.mjs). */
export const GOOGLE_FIREBASE_PROJECT = "findback-mobile-app";
export const GOOGLE_CLIENT_PACKAGE = "com.findback.app";

/** Upload credential NAMES only — values are never read here beyond presence. */
export const SENTRY_UPLOAD_ENV_NAMES = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
];

/** Parse --variant <name> / --variant=<name> (default: debug). Throws on misuse. */
export function parseVariant(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => a.startsWith("--variant"));
  const variant =
    (arg
      ? arg.includes("=")
        ? arg.split("=")[1]
        : argv[argv.indexOf(arg) + 1]
      : "debug") || "debug";
  if (!VARIANTS[variant]) {
    throw new Error(
      "build-apk: expected --variant <debug|signeddev|release> (default: debug).",
    );
  }
  return variant;
}

/**
 * Pure release-identity constructor. Version is the apps/mobile npm version,
 * sha is the 12-char git short SHA. Throws on anything else so a malformed
 * identity can never be embedded or uploaded.
 */
export function buildSentryRelease(version, sha) {
  const v = String(version ?? "").trim();
  const s = String(sha ?? "").trim();
  if (!/^\d+\.\d+\.\d+[-+0-9A-Za-z.]*$/.test(v)) {
    throw new Error("build-apk: refusing to build — apps/mobile version is not semver-shaped");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(s)) {
    throw new Error("build-apk: refusing to build — git SHA is not hex-shaped");
  }
  const release = `findback-mobile@${v}+${s}`;
  if (!SENTRY_RELEASE_RE.test(release)) {
    throw new Error("build-apk: refusing to build — Sentry release identity failed its shape check");
  }
  return release;
}

/** Read the mobile npm version. `read`/`path` are injectable for tests. */
export function readAppVersion({ read = readFileSync, path = MOBILE_PKG_PATH } = {}) {
  const version = JSON.parse(read(path, "utf8")).version;
  if (!version || !/^\d+\.\d+\.\d+/.test(String(version).trim())) {
    throw new Error("build-apk: refusing to build — apps/mobile/package.json has no usable version");
  }
  return String(version).trim();
}

/** Short-12 git SHA. `exec`/`cwd` are injectable for tests. */
export function resolveGitSha({ exec = execFileSync, cwd = REPO_ROOT } = {}) {
  const sha = String(exec("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8", cwd })).trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("build-apk: refusing to build — cannot derive a git short SHA");
  }
  return sha;
}

/**
 * Single source of truth for the Sentry identity a build embeds AND uploads.
 *
 * dist is null BY DESIGN, not by omission: the SDK init passes release only
 * (no dist — see the monitoring service), and per Sentry's matching rule an
 * event with dist null requires artifacts uploaded with NO dist. Passing
 * --dist would scope the artifacts away from our dist-less events and break
 * symbolication, so the upload builder below emits no --dist flag while dist
 * is null. If the SDK ever sends a dist, set it here and both sides move
 * together (the upload test pins exact sameness).
 */
export function resolveSentryIdentity(deps = {}) {
  const version = deps.version ?? readAppVersion(deps);
  const sha = deps.sha ?? resolveGitSha(deps);
  return { release: buildSentryRelease(version, sha), dist: null, version, sha };
}

/** Deliberate environment for a variant. Throws on unknown variants. */
export function environmentForVariant(variant) {
  const env = ENVIRONMENT_FOR_VARIANT[variant];
  if (!env) throw new Error(`build-apk: unknown variant ${variant}`);
  return env;
}

/**
 * Upload plan for FINDBACK_SENTRY_UPLOAD=true. Returns { enabled, missing }.
 * missing lists credential NAMES only — values never appear in any message.
 */
export function sentryUploadPlan(env = process.env) {
  const enabled = (env.FINDBACK_SENTRY_UPLOAD ?? "") === "true";
  if (!enabled) return { enabled: false, missing: [] };
  const missing = SENTRY_UPLOAD_ENV_NAMES.filter((n) => !(env[n] ?? "").trim());
  return { enabled: true, missing };
}

/**
 * Exact sentry-cli upload argv for an identity. Built FROM the identity object
 * so the upload can never drift from what the bundle embeds. No --dist flag
 * while identity.dist is null (see resolveSentryIdentity); a non-null dist is
 * passed through as --dist so both sides stay exactly the same.
 */
export function sentryUploadArgs({ org, project, identity, distDir = MOBILE_DIST_DIR }) {
  if (!org || !project || !identity?.release) {
    throw new Error("build-apk: sentry upload requires org, project, and release identity");
  }
  const argv = ["sourcemaps", "upload", "--org", org, "--project", project, "--release", identity.release];
  if (identity.dist !== null && identity.dist !== undefined) argv.push("--dist", identity.dist);
  argv.push(distDir);
  return argv;
}

/** Argv for the post-upload verification (release files list). Presence proof. */
export function sentryVerifyArgs({ org, project, identity }) {
  if (!org || !project || !identity?.release) {
    throw new Error("build-apk: sentry verify requires org, project, and release identity");
  }
  const argv = ["releases", "files", identity.release, "list", "--org", org, "--project", project];
  if (identity.dist !== null && identity.dist !== undefined) argv.push("--dist", identity.dist);
  return argv;
}

/** Symbolication status line token. Disabled builds must say NOT_UPLOADED. */
export function symbolicationLine({ uploaded }) {
  return `SENTRY_SYMBOLICATION=${uploaded ? "UPLOADED" : "NOT_UPLOADED"}`;
}

/**
 * Pure Firebase client-config validator mirroring
 * scripts/materialize-google-services.mjs (which stays the single writer).
 * Returns { ok, reason } with reasons only — never config values.
 */
export function validateGoogleServicesJson(value) {
  const config = typeof value === "string" ? safeParseJson(value) : value;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, reason: "malformed" };
  }
  if (config.private_key || config.type === "service_account") {
    return { ok: false, reason: "service-account-shaped" };
  }
  if (config.project_info?.project_id !== GOOGLE_FIREBASE_PROJECT) {
    return { ok: false, reason: "project-mismatch" };
  }
  const clients = Array.isArray(config.client) ? config.client : [];
  const pkg = clients.some(
    (c) => c?.client_info?.android_client_info?.package_name === GOOGLE_CLIENT_PACKAGE,
  );
  if (!pkg) return { ok: false, reason: "package-mismatch" };
  return { ok: true };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const defaultRun = (exe, args, opts) =>
  spawnSync(exe, args, { encoding: "utf8", ...opts });

/**
 * Ensure the Firebase Android client config for a variant.
 *
 * signeddev/release (push-required): GOOGLE_SERVICES_JSON_B64 present runs the
 * materializer (its errors surface verbatim — it prints no secrets); otherwise
 * an existing gitignored google-services.json is validated with the same
 * predicate; otherwise fail closed. debug: same materialize/validate when
 * available, else a documented FCM-disabled mode ({ mode: "disabled" }).
 */
export function ensureFirebaseConfig({
  variant,
  env = process.env,
  run = defaultRun,
  read = readFileSync,
  exists = existsSync,
  materializer = MATERIALIZER,
  googleServicesPath = GOOGLE_SERVICES_PATH,
  cwd = REPO_ROOT,
} = {}) {
  const pushRequired = variant === "signeddev" || variant === "release";
  const hasB64 = !!((env.GOOGLE_SERVICES_JSON_B64 ?? "").trim());
  if (hasB64) {
    const result = run(process.execPath, [materializer], { env, cwd });
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "").trim().split("\n").pop() || "materializer failed";
      throw new Error(`build-apk: refusing ${variant} build — Firebase client config invalid (${detail})`);
    }
    return { mode: "materialized", path: googleServicesPath };
  }
  if (exists(googleServicesPath)) {
    let parsed;
    try {
      parsed = JSON.parse(read(googleServicesPath, "utf8"));
    } catch {
      throw new Error(`build-apk: refusing ${variant} build — google-services.json is malformed`);
    }
    const check = validateGoogleServicesJson(parsed);
    if (!check.ok) {
      throw new Error(
        `build-apk: refusing ${variant} build — google-services.json ${check.reason} (expected project ${GOOGLE_FIREBASE_PROJECT}, package ${GOOGLE_CLIENT_PACKAGE})`,
      );
    }
    return { mode: "validated-file", path: googleServicesPath };
  }
  if (pushRequired) {
    throw new Error(
      `build-apk: refusing ${variant} build — push-required build lacks a valid Firebase client config (set GOOGLE_SERVICES_JSON_B64 or provide ${GOOGLE_SERVICES_PATH})`,
    );
  }
  return { mode: "disabled" };
}

/**
 * Verify the built web bundle carries the Sentry DSN host AND the release
 * identity. Presence only — messages never include either value.
 */
export function verifyBundleRelease({
  assetsDir = MOBILE_ASSETS_DIR,
  sentryHost,
  release,
  list = readdirSync,
  read = readFileSync,
} = {}) {
  if (!sentryHost || !release) {
    throw new Error("build-apk: bundle verification requires a Sentry host and release identity");
  }
  const files = list(assetsDir).filter((n) => n.endsWith(".js"));
  if (files.length === 0) throw new Error("build-apk: no JavaScript assets to verify in dist");
  const chunks = files.map((n) => read(resolve(assetsDir, n), "utf8"));
  if (!chunks.some((c) => c.includes(sentryHost))) {
    throw new Error("build-apk: Sentry DSN host missing from built bundle — refusing to package");
  }
  if (!chunks.some((c) => c.includes(release))) {
    throw new Error("build-apk: Sentry release identity missing from built bundle — refusing to package");
  }
  return { checked: files.length };
}

/** Recursively list *.map files under a dir (portable; no shell find). */
export function listSourcemaps({ distDir = MOBILE_DIST_DIR, list = readdirSync, isDir = (p) => statSync(p).isDirectory() } = {}) {
  const found = [];
  const walk = (dir) => {
    for (const name of list(dir)) {
      const full = join(dir, name);
      if (isDir(full)) walk(full);
      else if (name.endsWith(".map")) found.push(full);
    }
  };
  walk(distDir);
  return found;
}

/**
 * Delete every *.map and prove none remain, plus prove no sourceMappingURL
 * reference survives in shipped assets. Returns counts only.
 */
export function stripAndProveNoSourcemaps({
  distDir = MOBILE_DIST_DIR,
  assetsDir = MOBILE_ASSETS_DIR,
  list = readdirSync,
  read = readFileSync,
  remove = rmSync,
  isDir = (p) => statSync(p).isDirectory(),
} = {}) {
  const maps = listSourcemaps({ distDir, list, isDir });
  for (const file of maps) remove(file, { force: true });
  const remaining = listSourcemaps({ distDir, list, isDir });
  if (remaining.length > 0) {
    throw new Error(`build-apk: ${remaining.length} sourcemap(s) remain after strip — refusing to package`);
  }
  const js = list(assetsDir).filter((n) => n.endsWith(".js"));
  const refs = js.filter((n) => /sourceMappingURL/.test(read(resolve(assetsDir, n), "utf8")));
  if (refs.length > 0) {
    throw new Error("build-apk: sourceMappingURL reference remains in shipped bundle — refusing to package");
  }
  return { stripped: maps.length, checked: js.length };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isMainModule() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

function main() {
  let variant;
  try {
    variant = parseVariant();
  } catch (error) {
    fail(String(error.message ?? error));
  }

  let config;
  try {
    config = effectiveSupabaseConfig();
  } catch {
    fail("build-apk: refusing to build — valid VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY required (shell or root .env).");
  }
  // Pass the exact validated values to all subprocesses; Vite's root envDir and
  // the Android asset gate then compare against the same effective config.
  process.env.VITE_SUPABASE_URL = config.url;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = config.key;

  // Google Sign-In: the WEB/server OAuth client ID is the Credential Manager
  // audience. It flows env -> BuildConfig.GOOGLE_WEB_CLIENT_ID. Missing is
  // fail-closed at runtime for plain debug, but the Google-auth device build
  // (signeddev) and release require it outright so the artifact is not silently
  // shipped with a disabled provider.
  const google = effectiveGoogleConfig();
  if (google.ok) {
    process.env.GOOGLE_WEB_CLIENT_ID = google.clientId;
  } else if (variant === "debug") {
    console.warn(`build-apk: GOOGLE_WEB_CLIENT_ID ${google.reason} — Google sign-in will be hidden (fail-closed). Set it for a Google-auth build.`);
  } else {
    fail(`build-apk: refusing ${variant} build — GOOGLE_WEB_CLIENT_ID ${google.reason}. Export a Web OAuth client ID (*.apps.googleusercontent.com).`);
  }

  // FCM client config: materialize (B64) or validate the ignored file for
  // push-required variants; debug may run FCM-disabled (documented here).
  try {
    const fcm = ensureFirebaseConfig({ variant });
    if (fcm.mode === "disabled") {
      console.warn("build-apk: FCM-disabled mode (no Firebase client config; push will be inert). Set GOOGLE_SERVICES_JSON_B64 for a push-capable build.");
    } else {
      console.log(`build-apk: FCM client config ${fcm.mode} (project/package verified)`);
    }
  } catch (error) {
    fail(String(error.message ?? error));
  }

  // signeddev must carry the canonical findbackRelease signer (FBX-025). The
  // four ANDROID_KEYSTORE_* names are the existing release contract: presence
  // and non-blankness only, values are never printed. Gradle refuses to package
  // signeddev without them too, so a direct `assembleSigneddev` cannot bypass
  // this either — see the task-graph guard in apps/mobile/android/app/build.gradle.
  if (variant === "signeddev") {
    const missing = ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]
      .filter((name) => !process.env[name] || process.env[name].trim() === "");
    if (missing.length > 0) {
      fail(
        `build-apk: refusing signeddev build — incomplete canonical signing environment (${missing.join(", ")}). ` +
          "Export all four ANDROID_KEYSTORE_* values, or use --variant=debug.",
      );
    }
  }

  // Sentry is mandatory for installable builds. Resolved with Vite's own
  // loadEnv against apps/mobile (the SAME source vite build embeds into
  // import.meta.env); shell exports win over apps/mobile/.env* files.
  const sentry = checkEffectiveSentryDsn({ mode: "production" });
  if (!sentry.ok) {
    fail(
      `build-apk: refusing to build — VITE_SENTRY_DSN ${sentry.reason} ` +
        "(export a real https DSN or provide apps/mobile/.env.production).",
    );
  }

  // Release identity + deliberate environment (SYNC-3/10/11). One source of
  // truth: embedded into the bundle via VITE_SENTRY_RELEASE and reused
  // verbatim for the symbol upload below, so the two can never drift.
  let identity;
  try {
    identity = resolveSentryIdentity();
  } catch (error) {
    fail(String(error.message ?? error));
  }
  const sentryEnv = environmentForVariant(variant);
  process.env.VITE_SENTRY_RELEASE = identity.release;
  process.env.SENTRY_RELEASE = identity.release;
  process.env.VITE_SENTRY_ENVIRONMENT = sentryEnv;

  // Symbol-upload mode. Enabled builds emit hidden sourcemaps for upload;
  // disabled builds emit no maps at all (a stray opt-in without upload intent
  // is refused — maps must never ship unuploaded).
  const upload = sentryUploadPlan();
  if (upload.enabled) {
    if (upload.missing.length > 0) {
      fail(
        `build-apk: refusing upload build — missing upload config (${upload.missing.join(", ")}). ` +
          "Export all three (names only shown; values are never printed).",
      );
    }
    process.env.SENTRY_UPLOAD_SOURCEMAPS = "true";
  } else {
    if ((process.env.SENTRY_UPLOAD_SOURCEMAPS ?? "") === "true") {
      fail("build-apk: refusing to build — SENTRY_UPLOAD_SOURCEMAPS=true without FINDBACK_SENTRY_UPLOAD=true would ship maps unuploaded. Unset it or opt into upload mode.");
    }
    delete process.env.SENTRY_UPLOAD_SOURCEMAPS;
    console.log(`build-apk: ${symbolicationLine({ uploaded: false })} (no FINDBACK_SENTRY_UPLOAD opt-in; no .map files emitted)`);
  }

  const npm = (args) => {
    const result = spawnSync("npm", args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };

  console.log(`build-apk: variant = ${variant}`);
  console.log(`build-apk: Supabase host = ${config.host}`);
  console.log(`build-apk: Sentry = ${sentry.host} project=${sentry.projectId}`);
  console.log(`build-apk: Google = ${google.ok ? "configured" : "fail-closed"}`);
  console.log(`build-apk: Sentry release = ${identity.release} env=${sentryEnv}`);
  npm(["run", "build", "-w", "packages/shared"]);
  npm(["run", "build", "-w", "apps/mobile"]);

  // The bundle must carry the DSN host AND the release identity before any
  // upload or packaging step runs.
  try {
    const checked = verifyBundleRelease({ sentryHost: sentry.host, release: identity.release });
    console.log(`build-apk: bundle carries DSN host + release identity (${checked.checked} chunk(s))`);
  } catch (error) {
    fail(String(error.message ?? error));
  }

  if (upload.enabled) {
    const org = process.env.SENTRY_ORG.trim();
    const project = process.env.SENTRY_PROJECT.trim();
    const maps = listSourcemaps();
    if (maps.length === 0) {
      fail("build-apk: no .map files in apps/mobile/dist — the build must run with hidden sourcemaps for upload mode");
    }
    console.log(`build-apk: uploading ${maps.length} sourcemap(s) for release ${identity.release} (org/project from env; names only)`);
    const up = spawnSync("npx", ["-y", SENTRY_CLI_PIN, ...sentryUploadArgs({ org, project, identity })], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if (up.status !== 0) fail("build-apk: sourcemap upload failed — refusing to ship an unsymbolicated release");
    const verify = spawnSync("npx", ["-y", SENTRY_CLI_PIN, ...sentryVerifyArgs({ org, project, identity })], {
      encoding: "utf8",
      env: process.env,
      shell: process.platform === "win32",
    });
    const rows = String(verify.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (verify.status !== 0 || rows.length === 0) {
      fail("build-apk: sourcemap upload verification failed — refusing to ship an unsymbolicated release");
    }
    console.log(`build-apk: upload verified (${rows.length} artifact row(s))`);
    try {
      const stripped = stripAndProveNoSourcemaps();
      console.log(`build-apk: sourcemap strip verified (${stripped.stripped} removed; ${stripped.checked} chunk(s) with no sourceMappingURL)`);
    } catch (error) {
      fail(String(error.message ?? error));
    }
    console.log(`build-apk: ${symbolicationLine({ uploaded: true })} (${identity.release})`);
  }

  npm(["run", VARIANTS[variant], "-w", "apps/mobile"]);
}

if (isMainModule()) main();
