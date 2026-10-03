#!/usr/bin/env node
/**
 * Fetches the pinned Needle TEXT challenger assets (Cactus needle3).
 *
 * Two artifact classes, two destinations:
 * - weights `needle3.cact` (35,335,380 bytes) → `<repo>/build/needle/`
 *   (gitignored, NEVER packaged: the runtime downloader installs weights
 *   post-consent via the verified manager flow, exactly like `.litertlm`).
 * - NDK link engine per ABI (`libneedle.a` + `needle.h`) →
 *   `apps/mobile/android/app/src/main/cpp/third_party/needle/<abi>/`
 *   (gitignored build input for the `findback_needle` JNI bridge; the
 *   static archive links in, it never ships as an asset).
 *
 * DISABLED BY DEFAULT: exits 0 without downloading unless explicitly opted
 * in with NEEDLE_MODEL_ENABLED=1. Pin+sha pattern mirrors
 * fetch-use-model.mjs: refuses to overwrite a verified file, deletes
 * mismatched downloads, supports --check and --engine-only (CI/gradle
 * build input without the 35 MB weights), honours NEEDLE_MODEL_URL /
 * NEEDLE_ENGINE_URL for local fixture testing.
 *
 * Pin source: Hugging Face `Cactus-Compute/needle3` at commit rev
 * c7c415a3d1b3d929014bc6e866d51ebb971f7089 (Apache-2.0). Sizes + LFS oids
 * (content SHA-256) from the model tree API; needle.h SHA-256 computed from
 * the rev-pinned URL (same trust anchor: the pinned commit).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const WEIGHTS_DIR = join(REPO_ROOT, "build", "needle");
const WEIGHTS_PATH = join(WEIGHTS_DIR, "needle3.cact");
const ENGINE_DIR = join(REPO_ROOT, "apps/mobile/android/app/src/main/cpp/third_party/needle");

const NEEDLE_REV = "c7c415a3d1b3d929014bc6e866d51ebb971f7089";
const HF_BASE = `https://huggingface.co/Cactus-Compute/needle3/resolve/${NEEDLE_REV}`;

const WEIGHTS = {
  file: "needle3.cact",
  bytes: 35335380,
  sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  url: `${HF_BASE}/needle3.cact`,
};

// NDK link engine for arm64-v8a (devices). Upstream also publishes
// android-armv7 and a desktop linux-x86_64 engine, but neither links into
// an Android build: armv7 has no FindBack bridge target (32-bit builds stay
// Needle-unavailable, same as 64-bit-only vision) and the linux archive
// targets desktop glibc/libstdc++ (undefined bcmp/locale symbols against
// Bionic). The x86_64 emulator therefore reports Needle unavailable —
// measurement happens on arm64 hardware.
const ENGINES = {
  "arm64-v8a": {
    dir: "android-arm64",
    libBytes: 2128166,
    libSha256: "16752fb75adea7af89bbc435a97d1cda7e71bc74d04578d551d0d3bbd5f9e633",
    headerBytes: 3322,
    headerSha256: "90f347f9dca1199de79967ab199a56e0588bd473fe306051f8d80d146976a324",
  },
};

function sha256File(filePath) {
  const buffer = readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function verifyFile(filePath, expectedBytes, expectedSha256) {
  if (!existsSync(filePath)) {
    return { ok: false, reason: "missing" };
  }
  const stats = statSync(filePath);
  if (stats.size !== expectedBytes) {
    return { ok: false, reason: `size mismatch: expected ${expectedBytes}, got ${stats.size}` };
  }
  const hash = sha256File(filePath);
  if (hash !== expectedSha256) {
    return { ok: false, reason: `hash mismatch: expected ${expectedSha256}, got ${hash}` };
  }
  return { ok: true };
}

async function downloadTo(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);
  return buffer.length;
}

async function ensureFile(url, destPath, expectedBytes, expectedSha256, label) {
  const existing = verifyFile(destPath, expectedBytes, expectedSha256);
  if (existing.ok) {
    console.log(`Asset already verified: ${destPath}`);
    return;
  }
  console.log(`Downloading ${label} from ${url}...`);
  try {
    const bytes = await downloadTo(url, destPath);
    console.log(`Downloaded ${bytes} bytes to ${destPath}`);
  } catch (error) {
    if (existsSync(destPath)) unlinkSync(destPath);
    throw error;
  }
  const result = verifyFile(destPath, expectedBytes, expectedSha256);
  if (!result.ok) {
    console.error(`Verification failed: ${result.reason}`);
    if (existsSync(destPath)) {
      unlinkSync(destPath);
      console.log("Deleted mismatched download");
    }
    process.exit(1);
  }
  console.log("Asset verified successfully");
}

function enginePaths(abi) {
  const dir = join(ENGINE_DIR, abi);
  return { lib: join(dir, "libneedle.a"), header: join(dir, "needle.h") };
}

function checkAll() {
  let ok = true;
  const weights = verifyFile(WEIGHTS_PATH, WEIGHTS.bytes, WEIGHTS.sha256);
  console.log(weights.ok ? `OK: ${WEIGHTS_PATH}` : `MISSING: ${WEIGHTS_PATH} - ${weights.reason}`);
  if (!weights.ok) ok = false;
  for (const [abi, engine] of Object.entries(ENGINES)) {
    const paths = enginePaths(abi);
    const lib = verifyFile(paths.lib, engine.libBytes, engine.libSha256);
    const header = verifyFile(paths.header, engine.headerBytes, engine.headerSha256);
    console.log(
      lib.ok && header.ok
        ? `OK: engine ${abi}`
        : `MISSING: engine ${abi} - lib: ${lib.reason ?? "ok"}, header: ${header.reason ?? "ok"}`,
    );
    if (!lib.ok || !header.ok) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const engineOnly = args.includes("--engine-only");
  const enabled = process.env.NEEDLE_MODEL_ENABLED === "1";

  if (!enabled) {
    console.log("Needle fetch disabled by default (set NEEDLE_MODEL_ENABLED=1 to opt in). No download performed.");
    return;
  }

  if (checkOnly) {
    checkAll();
    return;
  }

  const weightsUrl = process.env.NEEDLE_MODEL_URL || WEIGHTS.url;
  const engineBase = process.env.NEEDLE_ENGINE_URL || null;

  const abis = Object.keys(ENGINES);
  for (const abi of abis) {
    const engine = ENGINES[abi];
    const paths = enginePaths(abi);
    const base = engineBase ?? `${HF_BASE}/${engine.dir}`;
    await ensureFile(`${base}/libneedle.a`, paths.lib, engine.libBytes, engine.libSha256, `needle engine ${abi}`);
    await ensureFile(`${base}/needle.h`, paths.header, engine.headerBytes, engine.headerSha256, `needle header ${abi}`);
  }

  if (!engineOnly) {
    await ensureFile(weightsUrl, WEIGHTS_PATH, WEIGHTS.bytes, WEIGHTS.sha256, "needle3 weights");
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
