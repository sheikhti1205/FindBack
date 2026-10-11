#!/usr/bin/env node
/**
 * Keyless-map provider gate (MAP pivot): fails the build when the Google
 * Maps/Places integration reappears, and when the pinned MapLibre Native
 * capability drifts.
 *
 * Fails when any production dependency graph or source contains:
 * - `@capacitor/google-maps` (npm dep or lockfile entry)
 * - Google Places Android SDK (`com.google.android.libraries.places`)
 * - `com.google.android.geo.API_KEY` manifest metadata
 * - `GOOGLE_MAPS_API_KEY` / `VITE_GOOGLE_MAPS_API_KEY` references
 * - `FindbackPlaces` bridge remnants
 *
 * Confirms:
 * - `mapLibreVersion` pin exists in variables.gradle and is referenced as
 *   `$mapLibreVersion` by the MapLibre dependency in app/build.gradle
 * - `FindbackMapPlugin.kt` RENDERER_VERSION matches that pin (single source)
 * - MAP_STYLE_URL BuildConfig wiring exists with an https default
 *
 * Deliberately NOT banned: Google Auth / Credential Manager, Firebase/FCM,
 * `GOOGLE_WEB_CLIENT_ID`, play-services-location, and external Google Maps
 * URL parsing/handoff (geo: URIs, maps.google.com links, Open-in-Maps).
 *
 * Pure Node builtins. Test suite: scripts/check-map-provider.test.mjs
 * Run: `node scripts/check-map-provider.mjs` from repo root.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BANNED_DEPENDENCY_PATTERNS = [
  "@capacitor/google-maps",
  "com.google.android.libraries.places",
];

const BANNED_SOURCE_PATTERNS = [
  "com.google.android.geo.API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "VITE_GOOGLE_MAPS_API_KEY",
  "googleMapsApiKey",
  "FindbackPlaces",
  "Places.initialize",
];

const DEPENDENCY_FILES = [
  "apps/mobile/package.json",
  "package-lock.json",
  "apps/mobile/android/app/build.gradle",
  "apps/mobile/android/capacitor.settings.gradle",
  "apps/mobile/android/app/capacitor.build.gradle",
];

const SOURCE_FILES = [
  "apps/mobile/android/app/build.gradle",
  "apps/mobile/android/app/src/main/AndroidManifest.xml",
  "apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java",
  "apps/mobile/vite.config.ts",
  ".env.example",
];

export function checkBannedHits(files, patterns, read = readFileSync) {
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = read(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      if (text.includes(pattern)) hits.push(`${file}: ${pattern}`);
    }
  }
  return hits;
}

export function readPin(text) {
  const match = /mapLibreVersion\s*=\s*'([^']+)'/.exec(text);
  return match ? match[1] : null;
}

/** Validate the MapLibre pin + style wiring; returns { ok, errors[] }. */
export function checkMapLibrePin(read = readFileSync) {
  const errors = [];
  let variables;
  let buildGradle;
  let plugin;
  try {
    variables = read(resolve(root, "apps/mobile/android/variables.gradle"), "utf8");
    buildGradle = read(resolve(root, "apps/mobile/android/app/build.gradle"), "utf8");
    plugin = read(
      resolve(root, "apps/mobile/android/app/src/main/java/com/findback/app/map/FindbackMapPlugin.kt"),
      "utf8",
    );
  } catch {
    return { ok: false, errors: ["map configuration files unreadable"] };
  }
  const pin = readPin(variables);
  if (!pin) {
    errors.push("mapLibreVersion pin missing in variables.gradle");
  } else {
    if (!buildGradle.includes("org.maplibre.gl:android-sdk-opengl:$mapLibreVersion")) {
      errors.push("MapLibre dependency must reference $mapLibreVersion (single version source)");
    }
    const renderer = /RENDERER_VERSION\s*=\s*"([^"]+)"/.exec(plugin)?.[1];
    if (renderer !== pin) {
      errors.push(`FindbackMapPlugin RENDERER_VERSION (${renderer ?? "missing"}) must match mapLibreVersion (${pin})`);
    }
  }
  if (!buildGradle.includes('buildConfigField "String", "MAP_STYLE_URL"')) {
    errors.push("MAP_STYLE_URL BuildConfig wiring missing in app/build.gradle");
  }
  const styleDefault = /FINDBACK_MAP_STYLE_URL"\) \?: "(https:\/\/[^"]+)"/.exec(buildGradle)?.[1];
  if (!styleDefault) {
    errors.push("MAP_STYLE_URL must carry an https default style URL");
  }
  return { ok: errors.length === 0, errors };
}

export function checkMapProvider(read = readFileSync) {
  const errors = [];
  for (const hit of checkBannedHits(DEPENDENCY_FILES, BANNED_DEPENDENCY_PATTERNS, read)) {
    errors.push(`banned map dependency: ${hit}`);
  }
  const sourceFiles = [...SOURCE_FILES, ...DEPENDENCY_FILES];
  for (const hit of checkBannedHits(sourceFiles, BANNED_SOURCE_PATTERNS, read)) {
    errors.push(`banned map reference: ${hit}`);
  }
  for (const error of checkMapLibrePin(read).errors) errors.push(error);
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkMapProvider();
  if (result.ok) {
    console.log("check-map-provider: PASS (keyless MapLibre pin intact, no Google Maps/Places remnants)");
  } else {
    console.error(`check-map-provider: ${result.errors.length} failure(s)\n${result.errors.join("\n")}`);
    process.exitCode = 1;
  }
}
