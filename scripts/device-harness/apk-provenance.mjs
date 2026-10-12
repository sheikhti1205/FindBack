#!/usr/bin/env node
/**
 * apk-provenance.mjs — deterministic APK provenance record (offline).
 *
 * Usage:
 *   node scripts/device-harness/apk-provenance.mjs --apk <path-to.apk> [--out <dir>]
 *
 * Collects names/presence/shapes ONLY, never secret values:
 *   git SHA (12 + full), package, versionName/versionCode, APK SHA256,
 *   signer fingerprint (apksigner verify --verbose --print-certs),
 *   Supabase host presence, Google Web client PRESENT/MISSING (shape only),
 *   Maps PRESENT/ABSENT (MapLibre pin vs banned Google Maps markers),
 *   Sentry PRESENT/MISSING (host/project shapes only).
 *
 * Writes <out>/provenance.json and prints a one-line summary.
 * Pure Node builtins. Exit non-zero on any missing input/tool.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

function fail(msg) {
  console.error(`apk-provenance: FAIL: ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed${r.stderr ? `: ${String(r.stderr).slice(0, 300)}` : ""}`);
  return (r.stdout ?? "").trim();
}

function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

// Host-only shape of a URL: hostname, never path/query/credentials.
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const apkArg = arg("--apk");
if (!apkArg) fail("expected --apk <path-to.apk>");
const apk = resolve(process.cwd(), apkArg);
if (!existsSync(apk)) fail(`APK not found: ${apk}`);

const outDir = resolve(process.cwd(), arg("--out") ?? "/tmp/findback-device-harness/provenance");
mkdirSync(outDir, { recursive: true });

// 1. Git SHA (exact; dirty flag is part of provenance).
const fullSha = run("git", ["rev-parse", "HEAD"], { cwd: ROOT });
const shortSha = fullSha.slice(0, 12);
const dirty = run("git", ["status", "--porcelain"], { cwd: ROOT }).length > 0;

// 2. APK SHA256.
const apkSha256 = sha256File(apk);

// 3. Package / versionName / versionCode via aapt (preferred) or aapt2 dump.
let packageName = null;
let versionName = null;
let versionCode = null;
{
  const dump = run("aapt", ["dump", "badging", apk]);
  const pkg = dump.match(/^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']+)'/m);
  if (!pkg) fail("aapt dump badging: package line not parsed");
  packageName = pkg[1];
  versionCode = pkg[2];
  versionName = pkg[3];
}

// 4. Signer fingerprint(s) — fingerprints only, never key material.
let signer = null;
{
  const out = run("apksigner", ["verify", "--verbose", "--print-certs", apk]);
  const certs = [...out.matchAll(/Signer.*certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/g)].map((m) => m[1].toLowerCase());
  const verified = /Verified using v1 scheme.*true|Verified using v2 scheme.*true|Verified using v3 scheme.*true/i.test(out);
  signer = { fingerprints_sha256: certs, verified };
  if (certs.length === 0) fail("apksigner: no signer SHA-256 digest found");
}

// 5. Bundled-web config presence: read APK JS chunks without logging values.
//    Mirrors scripts/check-mobile-build-config.mjs chunk selection.
function apkJsChunks() {
  const listing = run("unzip", ["-Z", "-1", apk]);
  const names = listing.split("\n").filter((n) => /^assets\/public\/assets\/[^/]+\.js$/.test(n));
  if (names.length === 0) fail("no bundled web JS chunks (assets/public/assets/*.js) in APK");
  return names.map((n) => {
    const r = spawnSync("unzip", ["-p", apk, n], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) fail(`cannot read APK entry ${n}`);
    return r.stdout;
  });
}
const chunks = apkJsChunks();
const has = (s) => chunks.some((c) => c.includes(s));

// Supabase: host presence only (URL value never printed, key never printed).
const SUPABASE_HOSTS = ["supabase.co", "supabase.in"];
const supabaseHostPresent = SUPABASE_HOSTS.some((h) => has(h));
// Google Web client: presence of the audience marker shape only.
const googleWebClientPresent = has("apps.googleusercontent.com");
// Maps: MapLibre PRESENT when its marker ships; Google Maps PRESENT when any
// banned marker ships (must be ABSENT per keyless-map pivot).
const BANNED_MAP_MARKERS = [
  "@capacitor/google-maps",
  "com.google.android.geo.API_KEY",
  "FindbackPlaces",
  "Places.initialize",
];
const maplibrePresent = has("maplibre") || has("MapLibre");
const googleMapsMarkersFound = BANNED_MAP_MARKERS.filter((m) => has(m));
const maps = {
  maplibre_present: maplibrePresent,
  google_maps: googleMapsMarkersFound.length === 0 ? "ABSENT" : `PRESENT (${googleMapsMarkersFound.join(",")})`,
};
// Sentry: host/project shapes only.
const sentryPresent = has("sentry") || has("ingest.sentry");

const record = {
  tool: "apk-provenance.mjs",
  git_sha_full: fullSha,
  git_sha12: shortSha,
  git_dirty: dirty,
  apk_sha256: apkSha256,
  package: packageName,
  version_name: versionName,
  version_code: versionCode,
  signer,
  supabase_host_present: supabaseHostPresent,
  supabase_host: supabaseHostPresent ? "(present; value withheld)" : "(absent)",
  google_web_client: googleWebClientPresent ? "PRESENT" : "MISSING",
  maps,
  sentry: sentryPresent ? "PRESENT" : "MISSING",
  note: "Names/presence/shapes only. No keys, DSNs, client IDs, or URLs recorded.",
};

writeFileSync(resolve(outDir, "provenance.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `apk-provenance: PASS sha=${shortSha}${dirty ? "+dirty" : ""} pkg=${packageName} v=${versionName}/${versionCode} ` +
    `apk_sha256=${apkSha256.slice(0, 16)}… signer_n=${signer.fingerprints_sha256.length} ` +
    `supabase=${supabaseHostPresent ? "present" : "ABSENT"} google=${record.google_web_client} ` +
    `maps=${maps.google_maps} sentry=${record.sentry} -> ${outDir}/provenance.json`,
);
void hostOf;
