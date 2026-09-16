#!/usr/bin/env node
/**
 * Fetches the pinned Universal Sentence Encoder (USE) model asset from MediaPipe.
 *
 * Downloads to: apps/mobile/android/app/src/main/assets/models/use/universal_sentence_encoder.tflite
 * Verifies: 6120274 bytes and pinned SHA-256
 * Supports: --check (verify existing asset without downloading)
 * Refuses to overwrite a verified file
 * Deletes mismatched downloads
 * Respects MEDIAPIPE_MODEL_URL env var for local fixture testing (writes nothing when set to local file)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const ASSET_DIR = join(REPO_ROOT, "apps/mobile/android/app/src/main/assets/models/use");
const ASSET_PATH = join(ASSET_DIR, "universal_sentence_encoder.tflite");

const PINNED_BYTES = 6120274;
const PINNED_SHA256 = "89ad3c74175dd8caa398cc22b657296d94302d20c525c12b58b29420f7249749";
const DEFAULT_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite";

function sha256File(filePath) {
  const buffer = readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function verifyAsset(filePath) {
  if (!existsSync(filePath)) {
    return { ok: false, reason: "missing" };
  }
  const stats = statSync(filePath);
  if (stats.size !== PINNED_BYTES) {
    return { ok: false, reason: `size mismatch: expected ${PINNED_BYTES}, got ${stats.size}` };
  }
  const hash = sha256File(filePath);
  if (hash !== PINNED_SHA256) {
    return { ok: false, reason: `hash mismatch: expected ${PINNED_SHA256}, got ${hash}` };
  }
  return { ok: true };
}

async function downloadModel(url, destPath) {
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

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const modelUrl = process.env.MEDIAPIPE_MODEL_URL || DEFAULT_MODEL_URL;

  // If MEDIAPIPE_MODEL_URL points to a local file, treat as fixture - verify only, no download
  const isLocalFixture = modelUrl.startsWith("file://") || (existsSync(modelUrl) && !modelUrl.startsWith("http"));

  if (checkOnly) {
    const result = verifyAsset(ASSET_PATH);
    if (result.ok) {
      console.log(`OK: ${ASSET_PATH} (${PINNED_BYTES} bytes, SHA-256 verified)`);
      process.exit(0);
    } else {
      console.error(`FAIL: ${ASSET_PATH} - ${result.reason}`);
      process.exit(1);
    }
  }

  // Check if asset already exists and is verified
  const existing = verifyAsset(ASSET_PATH);
  if (existing.ok) {
    console.log(`Asset already verified: ${ASSET_PATH}`);
    return;
  }

  // If local fixture, verify it but don't download
  if (isLocalFixture) {
    const fixturePath = modelUrl.replace("file://", "");
    const result = verifyAsset(fixturePath);
    if (result.ok) {
      console.log(`Local fixture verified: ${fixturePath}`);
    } else {
      console.error(`Local fixture invalid: ${fixturePath} - ${result.reason}`);
      process.exit(1);
    }
    return;
  }

  // Download the model
  console.log(`Downloading USE model from ${modelUrl}...`);
  try {
    const bytes = await downloadModel(modelUrl, ASSET_PATH);
    console.log(`Downloaded ${bytes} bytes to ${ASSET_PATH}`);

    // Verify the download
    const result = verifyAsset(ASSET_PATH);
    if (!result.ok) {
      console.error(`Verification failed: ${result.reason}`);
      // Delete mismatched download
      if (existsSync(ASSET_PATH)) {
        unlinkSync(ASSET_PATH);
        console.log("Deleted mismatched download");
      }
      process.exit(1);
    }

    console.log("Asset verified successfully");
  } catch (error) {
    console.error(`Download failed: ${error.message}`);
    // Clean up partial download
    if (existsSync(ASSET_PATH)) {
      unlinkSync(ASSET_PATH);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});