#!/usr/bin/env node
/**
 * Signeddev provenance gate (FBX-026).
 *
 * `npm run apk:signeddev` runs the wrapper checks, but a direct
 * `./gradlew assembleSigneddev` used to package the web bundle with no
 * verification at all. This is the Gradle-side equivalent: the same public
 * config provenance the wrapper establishes (Supabase client config, share
 * origin, Sentry DSN, Google web client id) plus the two web/App-Links
 * provenance files that must ship with it (assetlinks association and the
 * manifest's autoVerify contract).
 *
 * Presence and SHAPE only — no network calls, no values in output, never a
 * credential. Exits non-zero with one line per failed check.
 *
 * Run: `node scripts/check-signeddev-config.mjs [--assets <staged-public-dir>]`
 * (Gradle wires the default to the app's staged web surface).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";
import { effectiveShareOrigin } from "./check-share-config.mjs";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
import { effectiveGoogleConfig } from "./check-google-config.mjs";
import { verifyWebAssociation } from "./check-web-association.mjs";
import { checkMapConfig, mapPresence } from "./check-map-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = resolve(
  root,
  "apps/mobile/android/app/src/main/AndroidManifest.xml",
);
export const STAGED_PUBLIC_DIR = resolve(
  root,
  "apps/mobile/android/app/src/main/assets/public",
);

/**
 * The App-Links contract the APK is built with: one `autoVerify` VIEW filter
 * whose host is the Gradle placeholder fed by the share config (so it can
 * never drift from VITE_PUBLIC_SHARE_ORIGIN), HTTPS only, scoped to the
 * allowlisted paths: report links (`/r/`), password recovery (`/recovery`)
 * and the browser OAuth callback (`/auth/callback`). Any other path prefix is
 * rejected.
 *
 * @returns {string | null} error message, or null when the contract holds
 */
export const APPLINK_PATH_PREFIXES = ["/r/", "/recovery", "/auth/callback"];

export function checkAppLinksManifest(xml) {
  if (typeof xml !== "string" || xml.length === 0) return "AndroidManifest is empty";
  const filters = xml.match(/<intent-filter[^>]*android:autoVerify="true"[^>]*>[\s\S]*?<\/intent-filter>/g);
  if (!filters || filters.length === 0) return "no autoVerify App-Links intent-filter declared";
  if (filters.length > 1) return "expected exactly one autoVerify App-Links intent-filter";
  const [filter] = filters;
  const dataTags = filter.match(/<data\b[^>]*\/?>/g);
  if (!dataTags || dataTags.length === 0) return "App-Links intent-filter must declare at least one data element";
  const prefixes = new Set();
  for (const dataTag of dataTags) {
    const scheme = /android:scheme="([^"]*)"/.exec(dataTag)?.[1];
    if (scheme !== "https") return "App-Links data element must be https-only";
    const host = /android:host="([^"]*)"/.exec(dataTag)?.[1];
    if (host !== "${findbackShareHost}") {
      return "App-Links host must be the ${findbackShareHost} placeholder (share config is the single source)";
    }
    const pathPrefix = /android:pathPrefix="([^"]*)"/.exec(dataTag)?.[1];
    if (!pathPrefix || !APPLINK_PATH_PREFIXES.includes(pathPrefix)) {
      return "App-Links data element must use an allowlisted pathPrefix (/r/, /recovery, /auth/callback)";
    }
    prefixes.add(pathPrefix);
  }
  if (!prefixes.has("/r/")) return "App-Links intent-filter must cover the /r/ report-link path";
  if (!/android\.intent\.action\.VIEW/.test(filter)) return "App-Links filter must accept VIEW";
  if (!/android\.intent\.category\.BROWSABLE/.test(filter)) return "App-Links filter must be BROWSABLE";
  return null;
}

/**
 * Everything a signeddev package must prove before it is allowed to ship:
 * config provenance + App-Links manifest contract + staged web association.
 * Injectable `env`/`read` keep the checks unit-testable without the repo tree.
 */
export function checkSigneddevConfig({
  assetsRoot = STAGED_PUBLIC_DIR,
  manifestPath = MANIFEST_PATH,
  env = process.env,
  read = readFileSync,
} = {}) {
  const errors = [];
  const note = (fn) => {
    try {
      fn();
    } catch (error) {
      errors.push(String(error.message ?? error));
    }
  };

  note(() => effectiveSupabaseConfig());
  note(() => effectiveShareOrigin());
  const sentry = checkEffectiveSentryDsn();
  if (!sentry.ok) errors.push(`VITE_SENTRY_DSN ${sentry.reason}`);
  const google = effectiveGoogleConfig();
  if (!google.ok) errors.push(`GOOGLE_WEB_CLIENT_ID ${google.reason}`);

  // FBX-027: the map build truth (scripts/check-map-config.mjs, the single
  // owner) must hold for a signeddev package too, so a direct
  // `./gradlew assembleSigneddev` fails on malformed custom map config instead
  // of shipping a bundle whose web map truth diverges from BuildConfig.
  note(() => {
    const maps = checkMapConfig();
    if (!maps.ok) for (const error of maps.errors) errors.push(error);
  });

  note(() => {
    const manifestError = checkAppLinksManifest(read(manifestPath, "utf8"));
    if (manifestError) throw new Error(manifestError);
  });

  // Web association: with ANDROID_SIGNING_CERT_SHA256 exported (the CI case)
  // the staged pin must match it exactly; locally at least a well-formed pin
  // must be present so an App-Links association can never ship empty.
  note(() => {
    verifyWebAssociation({
      root: assetsRoot,
      pin: env.ANDROID_SIGNING_CERT_SHA256,
      requirePin: false,
      read,
    });
  });

  return { ok: errors.length === 0, errors };
}

/**
 * M-c local device-build provenance report.
 *
 * Canonical local device-build command: `npm run apk -- --variant=signeddev`
 * (scripts/build-apk.mjs). After it emits an APK, this report identifies the
 * artifact with a STRICTLY LIMITED field set — the only thing it may ever
 * print (see PROVENANCE_FIELDS): git SHA, package, version, versionCode, APK
 * SHA256, signer fingerprint, Supabase host/presence, Google Web client
 * PRESENT/ABSENT, Maps PRESENT/ABSENT, Sentry PRESENT/ABSENT. Never values:
 * no keys, no secrets, no URLs beyond the Supabase host, no cert material.
 *
 * Signer fingerprint resolution degrades honestly: apksigner (Android SDK)
 * first, then keytool JAR parsing (JDK only), else "UNAVAILABLE" — the
 * release verifier (scripts/verify-release-apks.sh) stays the rigorous
 * signer authority, not this report. Every external lookup is injectable via
 * `deps` so the field allowlist is unit-testable without git, an SDK, or an
 * APK on disk.
 */
export const PROVENANCE_FIELDS = [
  "gitSha",
  "package",
  "version",
  "versionCode",
  "apkSha256",
  "signerFingerprint",
  "supabaseHost",
  "supabaseKey",
  "googleWebClient",
  "maps",
  "sentry",
];

function gitOutput(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: root }).trim();
  } catch {
    return "";
  }
}

/** Best-effort signer fingerprint: apksigner, then keytool, else UNAVAILABLE. */
function defaultSignerFingerprint(apkPath) {
  const sdk = ((process.env.ANDROID_HOME ?? "") || (process.env.ANDROID_SDK_ROOT ?? "")).trim();
  if (sdk) {
    try {
      const found = execFileSync(
        "find", [`${sdk}/build-tools`, "-maxdepth", "2", "-name", "apksigner", "-type", "f"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).split("\n").map((line) => line.trim()).filter(Boolean).sort();
      if (found.length > 0) {
        const out = execFileSync(found[found.length - 1],
          ["verify", "--verbose", "--print-certs", apkPath],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const digest = /SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(out)?.[1]?.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
        if (/^[0-9A-F]{64}$/.test(digest ?? "")) return digest;
      }
    } catch {
      // Fall through to keytool, then UNAVAILABLE.
    }
  }
  try {
    const out = execFileSync("keytool", ["-printcert", "-jarfile", apkPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const digest = /SHA256:\s*([0-9A-Fa-f: ]+)/.exec(out)?.[1]?.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    if (/^[0-9A-F]{64}$/.test(digest ?? "")) return digest;
  } catch {
    // No v1 signature block or no keytool — report honestly below.
  }
  return "UNAVAILABLE";
}

export function buildProvenanceReport({ apkPath, deps = {} } = {}) {
  if (!apkPath || !existsSync(apkPath)) throw new Error(`APK not found: ${apkPath ?? "(none)"}`);
  const d = {
    gitSha: () => gitOutput(["rev-parse", "--short=12", "HEAD"]) || "unknown",
    // Mirrors the Gradle versionCode derivation (100000 + commit count,
    // VERSION_CODE_OVERRIDE wins); the shallow-clone guard lives in Gradle.
    versionCode: () => {
      const override = (process.env.VERSION_CODE_OVERRIDE ?? "").trim();
      if (/^\d+$/.test(override)) return Number(override);
      const count = gitOutput(["rev-list", "--count", "HEAD"]);
      if (/^\d+$/.test(count)) return 100000 + Number(count);
      return "unknown";
    },
    appVersion: () =>
      JSON.parse(readFileSync(resolve(root, "apps/mobile/package.json"), "utf8")).version,
    appPackage: () =>
      /applicationId\s+"([^"]+)"/.exec(
        readFileSync(resolve(root, "apps/mobile/android/app/build.gradle"), "utf8"),
      )?.[1] ?? "unknown",
    sha256File: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
    signerFingerprint: (path) => defaultSignerFingerprint(path),
    supabase: () => {
      try {
        const config = effectiveSupabaseConfig();
        return { host: config.host, key: "PRESENT" };
      } catch {
        return { host: "ABSENT", key: "ABSENT" };
      }
    },
    google: () => (effectiveGoogleConfig().ok ? "PRESENT" : "ABSENT"),
    maps: () => mapPresence(checkMapConfig().config),
    sentry: () => (checkEffectiveSentryDsn().ok ? "PRESENT" : "ABSENT"),
    ...deps,
  };
  const supabase = d.supabase();
  return {
    gitSha: d.gitSha(),
    package: d.appPackage(),
    version: d.appVersion(),
    versionCode: d.versionCode(),
    apkSha256: d.sha256File(apkPath),
    signerFingerprint: d.signerFingerprint(apkPath),
    supabaseHost: supabase.host,
    supabaseKey: supabase.key,
    googleWebClient: d.google(),
    maps: d.maps(),
    sentry: d.sentry(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--provenance") {
    const apkFlag = argv.indexOf("--apk");
    if (apkFlag === -1 || !argv[apkFlag + 1]) {
      console.error("check-signeddev-config: --provenance requires --apk <file>");
      process.exit(1);
    }
    try {
      console.log(JSON.stringify(buildProvenanceReport({ apkPath: resolve(argv[apkFlag + 1]) }), null, 2));
    } catch (error) {
      console.error(`check-signeddev-config: provenance failed: ${error.message}`);
      process.exit(1);
    }
  } else {
    let assetsRoot = STAGED_PUBLIC_DIR;
    const flag = argv.indexOf("--assets");
    if (flag !== -1) {
      if (!argv[flag + 1]) {
        console.error("check-signeddev-config: --assets requires a path");
        process.exit(1);
      }
      assetsRoot = resolve(argv[flag + 1]);
    } else if (argv.length > 0 && !argv[0].startsWith("--")) {
      assetsRoot = resolve(argv[0]);
    }
    const { ok, errors } = checkSigneddevConfig({ assetsRoot });
    if (!ok) {
      for (const error of errors) console.error(`check-signeddev-config: ${error}`);
      console.error("check-signeddev-config: FAIL");
      process.exit(1);
    }
    console.log("check-signeddev-config: PASS (config, share, sentry, google, maps, app-links, association)");
  }
}
