#!/usr/bin/env node
/**
 * Fetches the pinned SmolVLM2-500M LiteRT weights for benchmarking and
 * device provisioning.
 *
 * Upstream `litert-community/SmolVLM2-500M` at commit rev
 * dad030b6e56756201d670cfb4d042736a2ce3a5c (Apache-2.0):
 * `SmolVLM2-500M.litertlm`, 360,822,960 bytes, SHA-256
 * b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0
 * (matches the `smolvlm2-500M-vision` catalogue pin exactly).
 *
 * Destination `<repo>/build/bench-models/` (gitignored, NEVER packaged):
 * the bench vision runner and `adb push` provisioning read from here; the
 * production path installs weights post-consent through the verified
 * in-app downloader. Idempotent, `--check` verifies without downloading.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const DEST_DIR = join(REPO_ROOT, "build", "bench-models");
const DEST_PATH = join(DEST_DIR, "SmolVLM2-500M.litertlm");

const PIN = {
  repo: "litert-community/SmolVLM2-500M",
  rev: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
  file: "SmolVLM2-500M.litertlm",
  bytes: 360822960,
  sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
};
PIN.url = `https://huggingface.co/${PIN.repo}/resolve/${PIN.rev}/${PIN.file}`;

function verified() {
  if (!existsSync(DEST_PATH)) return { ok: false, reason: "missing" };
  const size = statSync(DEST_PATH).size;
  if (size !== PIN.bytes) return { ok: false, reason: `size mismatch: expected ${PIN.bytes}, got ${size}` };
  const hash = createHash("sha256").update(readFileSync(DEST_PATH)).digest("hex");
  if (hash !== PIN.sha256) return { ok: false, reason: `hash mismatch: expected ${PIN.sha256}, got ${hash}` };
  return { ok: true };
}

async function main() {
  const checkOnly = process.argv.slice(2).includes("--check");
  const result = verified();
  if (checkOnly) {
    console.log(result.ok ? `OK: ${DEST_PATH} (${PIN.bytes} bytes, SHA-256 verified)` : `FAIL: ${DEST_PATH} - ${result.reason}`);
    process.exit(result.ok ? 0 : 1);
  }
  if (result.ok) {
    console.log(`SmolVLM2 weights already verified: ${DEST_PATH}`);
    return;
  }
  console.log(`Downloading ${PIN.file} (${PIN.bytes} bytes) from ${PIN.url}...`);
  const response = await fetch(PIN.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(DEST_DIR, { recursive: true });
  writeFileSync(DEST_PATH, buffer);
  const after = verified();
  if (!after.ok) {
    if (existsSync(DEST_PATH)) unlinkSync(DEST_PATH);
    console.error(`Verification failed: ${after.reason}`);
    process.exit(1);
  }
  console.log("SmolVLM2 weights verified successfully");
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
