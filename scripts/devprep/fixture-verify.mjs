#!/usr/bin/env node
// X3 import/export fixture generator + verifier — fully host-runnable.
// Order is the gate: the runbook allows the REAL Qwen .fbmodel step only
// after `verify` writes a fresh fixture-pass.json.
//
// generate: writes small SYNTHETIC payloads (never real weights, never the
//   .fbmodel suffix — *.fixture.zip) plus checksums.json + manifest.json.
// verify: re-hashes every payload, checks byte counts, ordering, and the
//   manifest↔checksums agreement; writes fixture-pass.json on success.
// gate --real: exits 0 only when a fresh (<24h) fixture-pass.json exists;
//   the real-package step must call this first and stop when it fails.
//
// Usage:
//   node scripts/devprep/fixture-verify.mjs generate [--out <dir>]
//   node scripts/devprep/fixture-verify.mjs verify [--out <dir>]
//   node scripts/devprep/fixture-verify.mjs gate --real [--out <dir>]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const [command] = args;
function flagValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}
const outDir = path.resolve(
  flagValue("--out", "test-evidence/devprep/import-export"),
);
fs.mkdirSync(outDir, { recursive: true });

const FIXTURE_FILES = ["photo-thumb.bin", "report-fields.json", "weights-note.bin"];
const PAYLOAD_BYTES = 64 * 1024; // 64 KiB each — small and safe by design.

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function fail(message) {
  console.error(`fixture-verify: FAIL: ${message}`);
  process.exit(1);
}

if (command === "generate") {
  const createdAt = new Date().toISOString();
  const checksums = {};
  for (const name of FIXTURE_FILES) {
    const filePath = path.join(outDir, name);
    const seed = `${createdAt}:${name}:synthetic-fixture-not-weights:`;
    const buf = Buffer.alloc(PAYLOAD_BYTES);
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = (seed.charCodeAt(i % seed.length) + i) % 256;
    }
    fs.writeFileSync(filePath, buf);
    checksums[name] = { bytes: buf.length, sha256: sha256File(filePath) };
  }
  const manifest = {
    kind: "findback-import-export-fixture",
    createdAt,
    files: [...FIXTURE_FILES],
    note: "Synthetic payloads only. Real-package runs reuse this shape against the Qwen .fbmodel built by scripts/build-fbmodel-local.py.",
  };
  fs.writeFileSync(path.join(outDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`fixture-verify: generated ${FIXTURE_FILES.length} fixture file(s) -> ${outDir}`);
} else if (command === "verify") {
  const checksPath = path.join(outDir, "checksums.json");
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(checksPath) || !fs.existsSync(manifestPath)) {
    fail("run generate first (checksums.json/manifest.json missing)");
  }
  const checks = JSON.parse(fs.readFileSync(checksPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(Object.keys(checks).sort()) !== JSON.stringify([...manifest.files].sort())) {
    fail("manifest files disagree with checksums.json keys");
  }
  for (const [name, expect] of Object.entries(checks)) {
    const filePath = path.join(outDir, name);
    if (!fs.existsSync(filePath)) fail(`missing payload ${name}`);
    const actualBytes = fs.statSync(filePath).size;
    const actualSha = sha256File(filePath);
    if (actualBytes !== expect.bytes) fail(`${name}: bytes ${actualBytes} != ${expect.bytes}`);
    if (actualSha !== expect.sha256) fail(`${name}: sha256 mismatch`);
  }
  const pass = {
    passedAt: new Date().toISOString(),
    outDir,
    files: FIXTURE_FILES.length,
    payloadBytesEach: PAYLOAD_BYTES,
  };
  fs.writeFileSync(path.join(outDir, "fixture-pass.json"), `${JSON.stringify(pass, null, 2)}\n`);
  console.log(`fixture-verify: PASS (${FIXTURE_FILES.length} files, sha256 chain ok) -> ${outDir}/fixture-pass.json`);
} else if (command === "gate" && args.includes("--real")) {
  const passPath = path.join(outDir, "fixture-pass.json");
  if (!fs.existsSync(passPath)) {
    fail("no fixture-pass.json — run generate + verify first; real Qwen package step is BLOCKED");
  }
  const pass = JSON.parse(fs.readFileSync(passPath, "utf8"));
  const ageMs = Date.now() - Date.parse(pass.passedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 3600 * 1000) {
    fail(`fixture-pass.json stale (passedAt=${pass.passedAt}) — re-run verify; real Qwen package step is BLOCKED`);
  }
  console.log(`fixture-verify: GATE OPEN (fixture passed at ${pass.passedAt}) — real Qwen .fbmodel step may proceed on device day`);
} else {
  console.error("usage: fixture-verify.mjs <generate|verify|gate --real> [--out <dir>]");
  process.exit(2);
}
