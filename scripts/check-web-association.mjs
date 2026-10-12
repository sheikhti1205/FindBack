#!/usr/bin/env node
/**
 * Digital-Asset-Links (App Links) association verifier.
 *
 * Static only: reads the staged/published `.well-known/assetlinks.json` plus
 * `staticwebapp.config.json` and checks the three things App Links need —
 * the handle_all_urls relation, this app's package, and a well-formed SHA-256
 * certificate pin (optionally an EXACT match against the expected signer).
 * Nothing here touches the network, the keystore, or key material: the pin is
 * a public certificate fingerprint and is only ever compared, never logged.
 *
 * Run: `node scripts/check-web-association.mjs <web-root>` (web.yml passes
 * ANDROID_SIGNING_CERT_SHA256, which must then match exactly).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_PACKAGE = "com.findback.app";
export const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";

/** Lowercase hex without `:` separators; not validated. */
export function normalizeFingerprint(value) {
  return String(value ?? "").replace(/:/g, "").trim().toLowerCase();
}

export function isWellFormedFingerprint(value) {
  return /^[a-f0-9]{64}$/.test(normalizeFingerprint(value));
}

/**
 * Validate an assetlinks document. Returns an error string, or null when the
 * association is usable. `pin` is optional: supplied means "must match this
 * certificate"; absent means "at least one well-formed pin must exist".
 */
export function checkAssetLinks(links, { package: pkg = APP_PACKAGE, pin } = {}) {
  if (!Array.isArray(links)) return "assetlinks is not an array";
  const match = links.find(
    (link) =>
      Array.isArray(link?.relation) &&
      link.relation.includes(HANDLE_ALL_URLS) &&
      link?.target?.namespace === "android_app" &&
      link?.target?.package_name === pkg &&
      Array.isArray(link?.target?.sha256_cert_fingerprints) &&
      link.target.sha256_cert_fingerprints.length > 0 &&
      link.target.sha256_cert_fingerprints.every(isWellFormedFingerprint),
  );
  if (!match) return `assetlinks does not describe ${pkg} with a well-formed certificate pin`;
  if (pin !== undefined && pin !== null && pin !== "") {
    const wanted = normalizeFingerprint(pin);
    if (!isWellFormedFingerprint(wanted)) return "release signing fingerprint malformed";
    if (!match.target.sha256_cert_fingerprints.some((value) => normalizeFingerprint(value) === wanted)) {
      return "assetlinks does not match release signing pin";
    }
  }
  return null;
}

/** The association file must be served as data, never as the HTML fallback. */
export function checkStaticWebConfig(config) {
  const exclude = config?.navigationFallback?.exclude;
  if (!Array.isArray(exclude) || !exclude.includes("/.well-known/*")) {
    return "association must not fall back to HTML";
  }
  return null;
}

/**
 * Read + verify the association under `root`. With `requirePin` (the release/
 * web contract) a well-formed `pin` is mandatory and must match exactly;
 * without it a `pin` still has to match when one is supplied.
 */
export function verifyWebAssociation({
  root,
  pin,
  package: pkg = APP_PACKAGE,
  requirePin = true,
  read = readFileSync,
} = {}) {
  if (!root) throw new Error("association root missing");
  const supplied = pin === undefined || pin === null ? "" : normalizeFingerprint(pin);
  if (requirePin && !isWellFormedFingerprint(supplied)) throw new Error("release signing fingerprint missing");
  const links = JSON.parse(read(resolve(root, ".well-known/assetlinks.json"), "utf8"));
  const assetError = checkAssetLinks(links, { package: pkg, pin: supplied || undefined });
  if (assetError) throw new Error(assetError);
  const config = JSON.parse(read(resolve(root, "staticwebapp.config.json"), "utf8"));
  const configError = checkStaticWebConfig(config);
  if (configError) throw new Error(configError);
  return { package: pkg, pins: links.find((l) => l?.target?.package_name === pkg).target.sha256_cert_fingerprints.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const root = process.argv[2] || "apps/mobile/dist";
    verifyWebAssociation({ root, pin: process.env.ANDROID_SIGNING_CERT_SHA256 });
    console.log("Web association: PASS (release certificate pin; package; no HTML fallback)");
  } catch (error) {
    console.error(`Web association: FAIL (${error.message})`);
    process.exitCode = 1;
  }
}
