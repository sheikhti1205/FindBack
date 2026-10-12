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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";
import { effectiveShareOrigin } from "./check-share-config.mjs";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";
import { effectiveGoogleConfig } from "./check-google-config.mjs";
import { verifyWebAssociation } from "./check-web-association.mjs";

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
 * allowlisted `/r/` report route.
 *
 * @returns {string | null} error message, or null when the contract holds
 */
export function checkAppLinksManifest(xml) {
  if (typeof xml !== "string" || xml.length === 0) return "AndroidManifest is empty";
  const filters = xml.match(/<intent-filter[^>]*android:autoVerify="true"[^>]*>[\s\S]*?<\/intent-filter>/g);
  if (!filters || filters.length === 0) return "no autoVerify App-Links intent-filter declared";
  if (filters.length > 1) return "expected exactly one autoVerify App-Links intent-filter";
  const [filter] = filters;
  const dataTags = filter.match(/<data\b[^>]*\/?>/g);
  if (!dataTags || dataTags.length !== 1) return "App-Links intent-filter must declare exactly one data element";
  const dataTag = dataTags[0];
  const scheme = /android:scheme="([^"]*)"/.exec(dataTag)?.[1];
  if (scheme !== "https") return "App-Links data element must be https-only";
  const host = /android:host="([^"]*)"/.exec(dataTag)?.[1];
  if (host !== "${findbackShareHost}") {
    return "App-Links host must be the ${findbackShareHost} placeholder (share config is the single source)";
  }
  if (!/android:pathPrefix="\/r\/"/.test(dataTag)) return "App-Links pathPrefix must be /r/ (report links only)";
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
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
  console.log("check-signeddev-config: PASS (config, share, sentry, google, app-links, association)");
}
