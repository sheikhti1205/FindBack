#!/usr/bin/env node
/**
 * Reproducible fetch of the bundled on-device image-classification model.
 *
 * Runtime does NOT use this script — the model files are committed under
 * `apps/mobile/public/models/mobilenet/` and copied into every build. This
 * script exists only to re-download the exact upstream artifact when the model
 * needs to be refreshed or audited.
 *
 * It downloads a single pinned TensorFlow.js MobileNet V1 (alpha 0.25)
 * artifact, verifies the archive and every weight shard referenced by
 * `model.json`, and only then writes into the model directory. It never fetches
 * a URL supplied by the caller.
 *
 * Usage:
 *   node scripts/fetch-ml-model.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned model: MobileNet V1, depth multiplier 0.25, 224x224 ImageNet.
// Kaggle TensorFlow.js variant of the TensorFlow Hub model
// google/imagenet/mobilenet_v1_025_224/classification/1 (Apache-2.0).
const MODEL_URL =
  "https://www.kaggle.com/api/v1/models/google/mobilenet-v1/tfJs/025-224-classification/1/download";
const EXPECTED_FORMAT = "graph-model";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = path.join(repoRoot, "apps", "mobile", "public", "models", "mobilenet");

function fail(message) {
  console.error(`fetch-ml-model: ${message}`);
  process.exit(1);
}

function extractTarGz(archive, dest) {
  const result = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  if (result.error && result.error.code === "ENOENT") {
    fail(
      "the `tar` command was not found. Install tar (standard on Linux/macOS and " +
        "available as tar.exe on Windows 10+) and retry, or download the model manually."
    );
  }
  if (result.status !== 0) fail(`tar extraction failed (exit ${result.status}).`);
}

function readManifest(tmpDir) {
  const modelJsonPath = path.join(tmpDir, "model.json");
  if (!fs.existsSync(modelJsonPath)) fail("downloaded archive has no model.json.");
  let model;
  try {
    model = JSON.parse(fs.readFileSync(modelJsonPath, "utf8"));
  } catch (err) {
    fail(`model.json is not valid JSON: ${err.message}`);
  }
  if (model.format !== EXPECTED_FORMAT) {
    fail(`unexpected model format "${model.format}" (expected "${EXPECTED_FORMAT}").`);
  }
  const groups = Array.isArray(model.weightsManifest) ? model.weightsManifest : [];
  const shards = groups.flatMap((group) => (Array.isArray(group.paths) ? group.paths : []));
  if (shards.length === 0) fail("model.json references no weight shards.");
  for (const shard of shards) {
    if (shard.includes("..") || shard.startsWith("/") || shard.includes("\\")) {
      fail(`refusing suspicious shard path "${shard}".`);
    }
  }
  return { model, modelJsonPath, files: ["model.json", ...shards] };
}

async function main() {
  console.log(`fetch-ml-model: downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText}.`);

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "findback-ml-"));
  const archive = path.join(tmpParent, "model.tar.gz");
  const extractDir = path.join(tmpParent, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    fs.writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));

    // List entries first and reject anything that is not a flat file we expect.
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    if (listing.status !== 0) fail(`could not read archive listing (exit ${listing.status}).`);
    const entries = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const entry of entries) {
      if (entry.includes("..") || entry.startsWith("/") || entry.includes("\\")) {
        fail(`refusing suspicious archive entry "${entry}".`);
      }
    }
    if (!entries.includes("model.json")) fail("archive listing is missing model.json.");

    extractTarGz(archive, extractDir);
    const { model, modelJsonPath, files } = readManifest(extractDir);

    // Validate every referenced shard is present and non-empty before copying.
    let totalBytes = 0;
    for (const file of files) {
      const full = path.join(extractDir, file);
      if (!fs.existsSync(full)) fail(`referenced file "${file}" is missing from the archive.`);
      const size = fs.statSync(full).size;
      if (size === 0) fail(`referenced file "${file}" is empty.`);
      totalBytes += size;
    }
    const modelBytes = fs.statSync(modelJsonPath).size;
    console.log(
      `fetch-ml-model: verified ${files.length - 1} shard(s), ${modelBytes} bytes model.json, ` +
        `${totalBytes} bytes weights (${model.weightsManifest.length} group(s)).`
    );

    // Place atomically-ish: write to a staging dir, then swap expected files in.
    fs.mkdirSync(modelDir, { recursive: true });
    const expected = new Set(files);
    for (const existing of fs.readdirSync(modelDir)) {
      const isManaged = existing === "model.json" || existing.endsWith(".bin");
      if (isManaged && !expected.has(existing)) {
        fs.rmSync(path.join(modelDir, existing));
        console.log(`fetch-ml-model: removed stale ${existing}`);
      }
    }
    for (const file of files) {
      fs.copyFileSync(path.join(extractDir, file), path.join(modelDir, file));
    }
    console.log(`fetch-ml-model: wrote ${files.length} file(s) to ${path.relative(repoRoot, modelDir)}`);
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

main().catch((err) => fail(err?.stack || String(err)));
