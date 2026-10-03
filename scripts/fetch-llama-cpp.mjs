#!/usr/bin/env node
/**
 * Fetches the pinned llama.cpp lab source for the Android JNI challenger.
 *
 * Upstream `ggml-org/llama.cpp` at tag v0.5.0 (commit
 * c13fcbf684171d5e0bca3fc5c34be6a99174b05f): the codeload tarball is
 * downloaded, size+SHA-256 verified, and extracted to
 * `apps/mobile/android/app/src/main/cpp/third_party/llama.cpp`
 * (gitignored build input for the `findback_llama` JNI bridge).
 *
 * No weights are fetched here: lab GGUF evaluation files install at lab
 * time through the verified downloader, and LFM-licensed arms stay blocked
 * from production distribution by the license gate regardless.
 *
 * Idempotent: verified trees are never re-downloaded. `--check` verifies
 * without downloading. Local override via LLAMA_CPP_URL (must still match
 * the pinned size+hash unless LLAMA_CPP_PIN_SKIP=1, which CI never sets).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "..");
const DEST_DIR = join(REPO_ROOT, "apps/mobile/android/app/src/main/cpp/third_party/llama.cpp");
const MARKER = join(DEST_DIR, ".llama-pin-verified");

const PIN = {
  tag: "v0.5.0",
  commit: "c13fcbf684171d5e0bca3fc5c34be6a99174b05f",
  url: "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/tags/v0.5.0",
  bytes: 37561391,
  sha256: "fef9ed754f4e031fb5c663c29260feda4ebc241abb68d64a81c0f1df5f1748e2",
};

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verified() {
  if (!existsSync(MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER, "utf8"));
    if (marker.commit !== PIN.commit || marker.sha256 !== PIN.sha256) return false;
  } catch {
    return false;
  }
  return existsSync(join(DEST_DIR, "include", "llama.h")) && existsSync(join(DEST_DIR, "CMakeLists.txt"));
}

async function download(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);
  return destPath;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");

  if (checkOnly) {
    if (verified()) {
      console.log(`OK: llama.cpp ${PIN.tag} (${PIN.commit.slice(0, 12)}) verified at ${DEST_DIR}`);
      process.exit(0);
    }
    console.error(`FAIL: llama.cpp tree missing or pin-mismatched at ${DEST_DIR}`);
    process.exit(1);
  }

  if (verified()) {
    console.log(`llama.cpp ${PIN.tag} already verified at ${DEST_DIR}`);
    return;
  }

  const url = process.env.LLAMA_CPP_URL || PIN.url;
  const skipPin = process.env.LLAMA_CPP_PIN_SKIP === "1";
  console.log(`Downloading llama.cpp ${PIN.tag} from ${url}...`);
  const tmp = join(REPO_ROOT, "build", `llama-cpp-${PIN.tag}.tar.gz`);
  mkdirSync(dirname(tmp), { recursive: true });
  await download(url, tmp);
  const stats = statSync(tmp);
  if (!skipPin) {
    if (stats.size !== PIN.bytes) {
      rmSync(tmp, { force: true });
      console.error(`FAIL: size mismatch: expected ${PIN.bytes}, got ${stats.size}`);
      process.exit(1);
    }
    const hash = sha256File(tmp);
    if (hash !== PIN.sha256) {
      rmSync(tmp, { force: true });
      console.error(`FAIL: hash mismatch: expected ${PIN.sha256}, got ${hash}`);
      process.exit(1);
    }
  }
  rmSync(DEST_DIR, { recursive: true, force: true });
  mkdirSync(DEST_DIR, { recursive: true });
  execFileSync("tar", ["-xzf", tmp, "-C", DEST_DIR, "--strip-components=1"]);
  rmSync(tmp, { force: true });
  if (!existsSync(join(DEST_DIR, "include", "llama.h"))) {
    console.error("FAIL: extracted tree has no include/llama.h");
    process.exit(1);
  }
  writeFileSync(MARKER, JSON.stringify({ tag: PIN.tag, commit: PIN.commit, sha256: PIN.sha256 }));
  console.log(`llama.cpp ${PIN.tag} verified at ${DEST_DIR}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
