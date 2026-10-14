#!/usr/bin/env node
/**
 * Google Sign-In build configuration seam (W0, hardened W-E).
 *
 * The Android Credential Manager Google-ID audience is the WEB/server OAuth
 * client ID (NOT the Android client ID). It reaches the APK only through
 * `BuildConfig.GOOGLE_WEB_CLIENT_ID`, which the Gradle build reads from the
 * `GOOGLE_WEB_CLIENT_ID` environment variable (see app/build.gradle).
 *
 * This module is the single validator/loader for that value so every local
 * build path (scripts/build-apk.mjs, CI, manual) uses the same rule:
 *   - shell export wins; otherwise the ignored root .env is consulted;
 *   - the value must look like a Web OAuth client ID;
 *   - secret-shaped material (client secrets, pasted blobs/tokens) is
 *     refused outright — a client secret is NEVER required here (its only
 *     legitimate home is the Supabase Google-provider dashboard).
 *
 * Missing value is NOT a build failure for plain debug builds: the app is
 * fail-closed at runtime (Google sign-in stays hidden/disabled).
 * `requireGoogleConfig` / `--require` lets signed device-acceptance and
 * release builds opt into a hard requirement instead, so a misconfigured
 * signed candidate CANNOT be handed off.
 *
 * Enforcement wiring (read-only from here — owned by wrapper/Gradle files):
 *   - scripts/build-apk.mjs refuses signeddev/release variants when
 *     `effectiveGoogleConfig()` is not ok;
 *   - app/build.gradle `verifyReleaseConfig` / `verifySigneddevConfig`
 *     (FBX-028 precedent) run scripts/check-signeddev-config.mjs, which calls
 *     `effectiveGoogleConfig()` — so a direct `./gradlew assembleRelease`
 *     cannot bypass the wrapper either;
 *   - scripts/check-release-config.mjs (release.yml) adds the hard release
 *     gate plus the packaged-dex proof; `--apk` below gives the same
 *     packaged proof for any signed candidate outside release.yml.
 *
 * REMAINING OWNER ACTION (single item — no console access from source):
 * from the canonical release-signed APK (package `com.findback.app`, signer
 * SHA-1 `61:E9:32:D5:14:A0:28:7B:7B:6E:49:F1:90:70:2C:F4:F7:CF:D1:8A`), tap
 * Google and capture `adb logcat | grep GoogleAuth`. The `exceptionClass=`
 * token names the ONE console fix (provider-configuration → Google Cloud
 * console Android OAuth client for `com.findback.app` must list the release
 * SHA-1 above, consent test-users must cover the account, Supabase Auth →
 * Google must be enabled with this same Web client id). Everything provable
 * from source (shape, wiring, package alignment, baked bytes, signer match)
 * is asserted by this script with `--require --check-wiring --apk <file>`.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_CLIENT_ID = /^[0-9]{6,}-[a-z0-9_-]{6,}\.apps\.googleusercontent\.com$/i;
/** Client-secret prefixes / pasted secret material — refused, never required. */
const SECRET_SHAPED = /(^GOCSPX-)|secret|ya29\.|[{}]|\s/i;

/** Canonical Android applicationId (non-secret; must match the Cloud console client). */
export const GOOGLE_ANDROID_PACKAGE = "com.findback.app";
/** Canonical release signer SHA-1 (fingerprint, not a secret). */
export const CANONICAL_RELEASE_SHA1 = "61:E9:32:D5:14:A0:28:7B:7B:6E:49:F1:90:70:2C:F4:F7:CF:D1:8A";

const BUILD_GRADLE_PATH = resolve(root, "apps/mobile/android/app/build.gradle");
const GOOGLE_AUTH_PLUGIN_PATH = resolve(
  root,
  "apps/mobile/android/app/src/main/java/com/findback/app/GoogleAuthPlugin.java",
);
const ANDROID_MANIFEST_PATH = resolve(
  root,
  "apps/mobile/android/app/src/main/AndroidManifest.xml",
);

export function validateGoogleClientId(value) {
  const clientId = (value ?? "").trim();
  if (!clientId) return { ok: false, reason: "missing" };
  if (SECRET_SHAPED.test(clientId)) return { ok: false, reason: "secret_material" };
  if (!WEB_CLIENT_ID.test(clientId)) return { ok: false, reason: "malformed" };
  return { ok: true, clientId };
}

/** Shell export wins; then root .env `GOOGLE_WEB_CLIENT_ID`. */
export function effectiveGoogleConfig(envDir = root) {
  const env = loadEnv("production", envDir, "");
  const raw = (process.env.GOOGLE_WEB_CLIENT_ID ?? "").trim() || (env.GOOGLE_WEB_CLIENT_ID ?? "").trim();
  return validateGoogleClientId(raw);
}

/**
 * Fail-closed loader for signed candidates: throws unless a well-formed Web
 * client ID is PROVIDED. Reasons only — never values.
 */
export function requireGoogleConfig(envDir = root) {
  const result = effectiveGoogleConfig(envDir);
  if (!result.ok) {
    throw new Error(
      `GOOGLE_WEB_CLIENT_ID ${result.reason} — refusing signed Google-auth candidate. ` +
        `Export a Web OAuth client ID (*.apps.googleusercontent.com).`,
    );
  }
  return result.clientId;
}

/**
 * Proves the env → BuildConfig → bridge seam is actually wired in source:
 * build.gradle derives BuildConfig.GOOGLE_WEB_CLIENT_ID from the
 * GOOGLE_WEB_CLIENT_ID env var, the bridge consumes that BuildConfig field,
 * and neither prod file hard-codes a real `*.apps.googleusercontent.com`
 * value. Injectable `read` keeps it unit-testable. Reasons only.
 */
export function checkGoogleBuildWiring({ read = readFileSync } = {}) {
  const errors = [];
  let gradle = "";
  let plugin = "";
  try {
    gradle = read(BUILD_GRADLE_PATH, "utf8");
  } catch {
    errors.push("build.gradle unreadable");
  }
  try {
    plugin = read(GOOGLE_AUTH_PLUGIN_PATH, "utf8");
  } catch {
    errors.push("GoogleAuthPlugin unreadable");
  }
  if (gradle) {
    if (!gradle.includes('System.getenv("GOOGLE_WEB_CLIENT_ID")')) {
      errors.push("build.gradle does not source GOOGLE_WEB_CLIENT_ID from env");
    }
    if (!gradle.includes('buildConfigField "String", "GOOGLE_WEB_CLIENT_ID"')) {
      errors.push("build.gradle does not bake BuildConfig.GOOGLE_WEB_CLIENT_ID");
    }
    if (/[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/.test(gradle)) {
      errors.push("build.gradle hard-codes a Google client ID");
    }
  }
  if (plugin) {
    if (!plugin.includes("BuildConfig.GOOGLE_WEB_CLIENT_ID")) {
      errors.push("GoogleAuthPlugin does not consume BuildConfig.GOOGLE_WEB_CLIENT_ID");
    }
    if (/[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/.test(plugin)) {
      errors.push("GoogleAuthPlugin hard-codes a Google client ID");
    }
    if (/Log\.[wid].*([Ii]dToken|nonce)/.test(plugin)) {
      errors.push("GoogleAuthPlugin may log token/nonce material");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Proves the packaged applicationId matches the canonical package the Cloud
 * console Android OAuth client is registered for. Injectable `read` keeps it
 * unit-testable. (Signer SHA-1 match needs the artifact — see
 * `verifyApkGoogleBake`.)
 */
export function checkAndroidPackageAlignment({ read = readFileSync } = {}) {
  const errors = [];
  try {
    const gradle = read(BUILD_GRADLE_PATH, "utf8");
    const namespace = /namespace\s*=\s*"([^"]+)"/.exec(gradle)?.[1];
    const applicationId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1];
    if (namespace && namespace !== GOOGLE_ANDROID_PACKAGE) {
      errors.push(`namespace ${namespace} is not ${GOOGLE_ANDROID_PACKAGE}`);
    }
    if (applicationId && applicationId !== GOOGLE_ANDROID_PACKAGE) {
      errors.push(`applicationId ${applicationId} is not ${GOOGLE_ANDROID_PACKAGE}`);
    }
    if (!namespace || !applicationId) errors.push("package identifiers unreadable in build.gradle");
  } catch {
    errors.push("build.gradle unreadable");
  }
  try {
    const manifest = read(ANDROID_MANIFEST_PATH, "utf8");
    const pkg = /package="([^"]+)"/.exec(manifest)?.[1];
    if (pkg && pkg !== GOOGLE_ANDROID_PACKAGE) {
      errors.push(`manifest package ${pkg} is not ${GOOGLE_ANDROID_PACKAGE}`);
    }
  } catch {
    // The manifest package attribute is optional on newer Gradle (namespace
    // wins); an unreadable manifest is not a failure when build.gradle pins it.
  }
  return { ok: errors.length === 0, errors };
}

function normalizeFingerprint(value) {
  return String(value ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

const defaultRun = (exe, args, opts) => execFileSync(exe, args, { encoding: "utf8", ...opts });

/**
 * Best-effort signer SHA-1 via apksigner (Android SDK) or keytool (JDK).
 * Returns the normalized hex string or "UNAVAILABLE" — never cert material.
 */
export function getApkSignerSha1(apkPath, { run = defaultRun } = {}) {
  const sdk = (process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "").trim();
  if (sdk) {
    try {
      const found = run("find", [`${sdk}/build-tools`, "-maxdepth", "2", "-name", "apksigner", "-type", "f"]);
      const apksigner = String(found.stdout ?? found ?? "").split("\n").map((l) => l.trim()).filter(Boolean).sort().pop();
      if (apksigner) {
        const out = run(apksigner, ["verify", "--verbose", "--print-certs", apkPath]);
        const sha1 = /SHA-1 digest:\s*([0-9a-fA-F:]+)/.exec(String(out.stdout ?? out ?? ""))?.[1];
        if (/^[0-9A-F]{40}$/.test(normalizeFingerprint(sha1))) return normalizeFingerprint(sha1);
      }
    } catch {
      // Fall through to keytool, then UNAVAILABLE.
    }
  }
  try {
    const out = run("keytool", ["-printcert", "-jarfile", apkPath]);
    const sha1 = /SHA1:\s*([0-9A-Fa-f: ]+)/.exec(String(out.stdout ?? out ?? ""))?.[1];
    if (/^[0-9A-F]{40}$/.test(normalizeFingerprint(sha1))) return normalizeFingerprint(sha1);
  } catch {
    // No signature block or no keytool — report honestly below.
  }
  return "UNAVAILABLE";
}

/**
 * Concatenated classes*.dex bytes of an APK (ASCII needles survive MUTF-8).
 * Injectable `run` keeps it unit-testable without an SDK.
 */
export function readApkDexBytes(apkPath, { run = defaultRun } = {}) {
  const listing = run("unzip", ["-Z", "-1", apkPath]);
  const stdout = String(listing?.stdout ?? listing ?? "");
  if (listing?.status !== undefined && listing.status !== 0) {
    throw new Error("cannot inspect APK (unzip -Z -1 failed)");
  }
  const dexes = stdout.split("\n").map((l) => l.trim()).filter((n) => /^classes\d*\.dex$/.test(n));
  if (dexes.length === 0) throw new Error("no classes dex in APK");
  const parts = [];
  for (const name of dexes) {
    const file = run("unzip", ["-p", apkPath, name], { maxBuffer: 64 * 1024 * 1024 });
    if (file?.status !== undefined && file.status !== 0) throw new Error("cannot read packaged dex");
    parts.push(Buffer.isBuffer(file) ? file : Buffer.from(String(file?.stdout ?? file ?? ""), "binary"));
  }
  return Buffer.concat(parts);
}

function dexClientIds(dexBytes) {
  const text = Buffer.isBuffer(dexBytes) ? dexBytes.toString("binary") : String(dexBytes ?? "");
  const found = text.match(/[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/g) ?? [];
  return [...new Set(found)];
}

/**
 * Post-build proof on the final artifact (fail-closed, reasons only):
 * the dex must carry EXACTLY the expected Web client ID (present, exact
 * match, no second/stray client ID — e.g. an Android client id must never be
 * baked), contain no secret shapes, and the signer SHA-1 must equal the
 * canonical release fingerprint. Injectable `deps` keep it unit-testable.
 */
export function verifyApkGoogleBake(apkPath, { clientId, dexBytes, signerSha1 } = {}) {
  const errors = [];
  if (!apkPath || !existsSync(apkPath)) errors.push("apk not found");
  if (!clientId || !validateGoogleClientId(clientId).ok) errors.push("expected GOOGLE_WEB_CLIENT_ID invalid");
  let bytes = dexBytes;
  if (errors.length === 0 && !bytes) {
    try {
      bytes = readApkDexBytes(apkPath);
    } catch {
      errors.push("apk dex unreadable");
    }
  }
  if (errors.length === 0) {
    const ids = dexClientIds(bytes);
    if (!ids.includes(clientId)) errors.push("google-client-missing");
    else if (ids.length !== 1) errors.push("google-client-ambiguous");
    const text = (Buffer.isBuffer(bytes) ? bytes.toString("binary") : String(bytes ?? "")).slice(0, 8 * 1024 * 1024);
    if (/GOCSPX-/i.test(text)) errors.push("secret-shaped");
  }
  if (errors.length === 0) {
    const sha1 = signerSha1 ?? getApkSignerSha1(apkPath);
    if (sha1 === "UNAVAILABLE") errors.push("signer-unverified");
    else if (sha1 !== normalizeFingerprint(CANONICAL_RELEASE_SHA1)) errors.push("signer-mismatch");
  }
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const require = argv.includes("--require");
  const wiringFlag = argv.indexOf("--check-wiring");
  const apkFlag = argv.indexOf("--apk");
  const fail = (message) => {
    console.error(`check-google-config: FAIL: ${message}`);
    process.exit(1);
  };

  if (apkFlag !== -1) {
    const apkPath = argv[apkFlag + 1];
    if (!apkPath) fail("--apk requires a path");
    let clientId = "";
    try {
      clientId = requireGoogleConfig(process.env.FINDBACK_ENV_DIR || root);
    } catch (error) {
      fail(String(error.message ?? error));
    }
    const wiring = checkGoogleBuildWiring();
    if (!wiring.ok) fail(`build wiring: ${wiring.errors.join("; ")}`);
    const pkg = checkAndroidPackageAlignment();
    if (!pkg.ok) fail(`package alignment: ${pkg.errors.join("; ")}`);
    const baked = verifyApkGoogleBake(apkPath, { clientId });
    if (!baked.ok) fail(`packaged GOOGLE_WEB_CLIENT_ID ${baked.errors.join("; ")}`);
    console.log("check-google-config: APK PASS (baked ID exact + sole, no secret shapes, canonical signer)");
  } else if (wiringFlag !== -1) {
    const wiring = checkGoogleBuildWiring();
    if (!wiring.ok) fail(`build wiring: ${wiring.errors.join("; ")}`);
    const pkg = checkAndroidPackageAlignment();
    if (!pkg.ok) fail(`package alignment: ${pkg.errors.join("; ")}`);
    console.log("check-google-config: WIRING PASS (env→BuildConfig→bridge, canonical package, no hard-coded IDs)");
  } else if (require) {
    try {
      const clientId = requireGoogleConfig(process.env.FINDBACK_ENV_DIR || root);
      console.log(`check-google-config: PROVIDED (${clientId.length} chars)`);
    } catch (error) {
      fail(String(error.message ?? error));
    }
  } else {
    const result = effectiveGoogleConfig(process.env.FINDBACK_ENV_DIR || root);
    if (result.ok) console.log(`check-google-config: PROVIDED (${result.clientId.length} chars)`);
    else {
      console.log(`check-google-config: MISSING or INVALID (${result.reason}) — Google sign-in stays fail-closed`);
      if (result.reason === "malformed" || result.reason === "secret_material") process.exitCode = 1;
    }
  }
}
