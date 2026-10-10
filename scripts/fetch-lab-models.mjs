#!/usr/bin/env node
/**
 * fetch-lab-models: lab-channel fetch support for model-lab candidates.
 *
 * Lists the ten lab candidates with their pins, licenses, runtimes, and RAM
 * estimates, and resolves a benchmark/eval-only download plan. Production
 * channels (bundle/download) are refused for LFM arms and for any candidate
 * whose pins are still pending verification — the gate fails closed with a
 * named reason, never a silent fetch.
 *
 * Baselines with verified pins delegate to the existing fetch scripts:
 *   Qwen3 0.6B + SmolVLM2 500M weights live under build/bench-models/.
 * Pending candidates print their upstream repo + expected file so the owner
 * can verify revision+sha before any bytes move.
 *
 * Usage:
 *   node scripts/fetch-lab-models.mjs --list
 *   node scripts/fetch-lab-models.mjs --plan --channel benchmark
 *   node scripts/fetch-lab-models.mjs --fetch <modelId> --channel benchmark
 */

const CANDIDATES = [
  { modelId: "qwen3-0.6b-dynamic-int4", repo: "litert-community/Qwen3-0.6B", file: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76", sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856", license: "Apache-2.0", runtime: "litert-lm", format: "litertlm", ram: "1500/2048 MiB", verified: true, baseline: true },
  { modelId: "qwen3-1.7b-dynamic-int4", repo: "litert-community/Qwen3-1.7B", file: "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm", revision: "pending-verification", sha256: "pending-verification", license: "Apache-2.0", runtime: "litert-lm", format: "litertlm", ram: "2200/3072 MiB", verified: false, baseline: false },
  { modelId: "lfm2-350m-q4_0", repo: "LiquidAI/LFM2-350M", file: "LFM2-350M-Q4_0.gguf", revision: "pending-verification", sha256: "pending-verification", license: "LFM-1.0", runtime: "llama-cpp", format: "gguf", ram: "1200/1800 MiB", verified: false, baseline: false },
  { modelId: "lfm2-700m-q4_0", repo: "LiquidAI/LFM2-700M", file: "LFM2-700M-Q4_0.gguf", revision: "pending-verification", sha256: "pending-verification", license: "LFM-1.0", runtime: "llama-cpp", format: "gguf", ram: "1500/2200 MiB", verified: false, baseline: false },
  { modelId: "lfm2-1.2b-q4_0", repo: "LiquidAI/LFM2-1.2B", file: "LFM2-1.2B-Q4_0.gguf", revision: "pending-verification", sha256: "pending-verification", license: "LFM-1.0", runtime: "llama-cpp", format: "gguf", ram: "1800/2600 MiB", verified: false, baseline: false },
  { modelId: "granite-3.3-2b-instruct-q4_0", repo: "ibm-granite/granite-3.3-2b-instruct", file: "granite-3.3-2b-instruct-Q4_0.gguf", revision: "pending-verification", sha256: "pending-verification", license: "Apache-2.0", runtime: "llama-cpp", format: "gguf", ram: "2300/3200 MiB", verified: false, baseline: false },
  { modelId: "smolvlm2-500M-vision", repo: "litert-community/SmolVLM2-500M", file: "SmolVLM2-500M.litertlm", revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c", sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0", license: "Apache-2.0", runtime: "litert-lm", format: "litertlm", ram: "1500/2048 MiB", verified: true, baseline: true },
  { modelId: "lfm2-vl-450m-int4", repo: "LiquidAI/LFM2-VL-450M", file: "LFM2-VL-450M-int4.litertlm", revision: "1abed04b6fe71314d8c446a1371c03d7c332266d", sha256: "45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797", license: "LFM-1.0", runtime: "litert-lm", format: "litertlm", ram: "1600/2300 MiB", verified: false, baseline: false },
  { modelId: "lfm2-vl-1.6b-int4", repo: "LiquidAI/LFM2-VL-1.6B", file: "LFM2-VL-1.6B-int4.litertlm", revision: "pending-verification", sha256: "pending-verification", license: "LFM-1.0", runtime: "litert-lm", format: "litertlm", ram: "2400/3400 MiB", verified: false, baseline: false },
  { modelId: "qwen3-vl-2b-instruct-int4", repo: "Qwen/Qwen3-VL-2B-Instruct", file: "Qwen3-VL-2B-Instruct-int4.litertlm", revision: "pending-verification", sha256: "pending-verification", license: "Apache-2.0", runtime: "litert-lm", format: "litertlm", ram: "2400/3400 MiB", verified: false, baseline: false },
];

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function gate(candidate, channel) {
  if (channel === "bundle" || channel === "download") {
    if (candidate.license === "LFM-1.0") {
      return { allowed: false, reason: `LFM Open License v1.0 (${candidate.modelId}): ${channel} blocked — benchmark/eval-only` };
    }
    if (!candidate.verified) {
      return { allowed: false, reason: `${candidate.modelId}: ${channel} blocked — pins pending verification` };
    }
    return { allowed: true, reason: `${candidate.modelId}: ${channel} allowed (verified pins)` };
  }
  return { allowed: true, reason: `${candidate.modelId}: ${channel} allowed for lab evaluation only` };
}

function list() {
  for (const c of CANDIDATES) {
    console.log(`${c.modelId} | ${c.repo}/${c.file} | rev ${c.revision} | sha ${c.sha256.slice(0, 12)}… | ${c.license} | ${c.runtime}/${c.format} | RAM ${c.ram} | ${c.verified ? "verified-baseline" : "pending-verification"}`);
  }
}

function plan(channel) {
  for (const c of CANDIDATES) {
    const decision = gate(c, channel);
    console.log(`${decision.allowed ? "ALLOW" : "BLOCK"} ${c.modelId} (${channel}): ${decision.reason}`);
  }
}

function fetchOne(modelId, channel) {
  const candidate = CANDIDATES.find((c) => c.modelId === modelId);
  if (!candidate) {
    console.error(`unknown lab model ${modelId}`);
    process.exit(1);
  }
  const decision = gate(candidate, channel);
  if (!decision.allowed) {
    console.error(`refused: ${decision.reason}`);
    process.exit(1);
  }
  if (!candidate.verified) {
    console.log(`lab fetch planned (fixture only, weights pending verification): ${candidate.repo}/${candidate.file}`);
    console.log(`next: verify upstream revision+sha, record in apps/mobile/src/services/ai/benchmark/labCatalog.ts, then re-run with verified pins.`);
    return;
  }
  console.log(`verified baseline: fetch via existing pinned scripts into build/bench-models/${candidate.file}`);
  console.log(`  text baseline: node scripts/fetch-use-model.mjs (Qwen3 0.6B)`);
  console.log(`  vision baseline: node scripts/fetch-smolvlm-model.mjs (SmolVLM2 500M)`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    list();
    return;
  }
  if (argv.includes("--plan")) {
    plan(flag(argv, "--channel") ?? "benchmark");
    return;
  }
  const fetchId = flag(argv, "--fetch");
  if (fetchId) {
    fetchOne(fetchId, flag(argv, "--channel") ?? "benchmark");
    return;
  }
  console.error("usage: fetch-lab-models.mjs --list | --plan [--channel benchmark] | --fetch <modelId> [--channel benchmark]");
  process.exit(2);
}

main();
