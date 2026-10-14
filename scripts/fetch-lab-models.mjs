#!/usr/bin/env node
/** Supply planning only. Weights are acquired through the canonical Android
 * Advanced workflow or the existing baseline fetch scripts, not this command.
 * Acquisition is not product qualification; HF aliases are not independent
 * outage mirrors. Language/projector files keep independent immutable pins.
 */
import { readSupplyCandidates } from "./read-model-supply.mjs";
import { PINNED_BASELINE_MODELS } from "./fetch-model-notices.mjs";
import { checkModelNoticesFile } from "./check-model-notices.mjs";

const candidates = [...PINNED_BASELINE_MODELS, ...readSupplyCandidates()];
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const channel = args.includes("--channel") ? value("--channel") : "benchmark";
if (!["bundle", "download", "benchmark", "eval"].includes(channel)) {
  console.error("Unknown acquisition channel"); process.exit(2);
}
const errors = checkModelNoticesFile();
if (errors.length) { console.error("Supply plan refused: source-linked license/provenance packet failed validation"); process.exit(1); }

function gate(d) {
  const pinned = /^[a-f0-9]{40}$/.test(d.revision) && /^[a-f0-9]{64}$/.test(d.sha256) && d.bytes > 0;
  if (!pinned) return { allowed: false, reason: "Exact artifact pins required" };
  if (channel === "bundle") return { allowed: false, reason: "FindBack does not package model weights; product policy, not an upstream redistribution prohibition" };
  return { allowed: true, reason: `${d.upstreamRepo.includes("LFM") ? "Conditional LFM Open License v1.0 (§4 attribution/NOTICE, §5 commercial eligibility)" : "Apache-2.0 attribution and applicable NOTICE"}; no new product qualification` };
}
function line(d) {
  const decision = gate(d);
  console.log(`${decision.allowed ? "ALLOW" : "BLOCK"} ${d.modelId} (${channel}): ${decision.reason}`);
}
if (args.includes("--list")) {
  for (const d of candidates) {
    console.log(`${d.modelId} | ${d.upstreamRepo}/${d.fileName} | rev ${d.revision} | bytes ${d.bytes} | sha ${d.sha256}`);
    for (const file of d.companions ?? []) console.log(`  companion ${file.fileName} | bytes ${file.bytes} | sha ${file.sha256}`);
  }
} else if (args.includes("--plan")) {
  candidates.forEach(line);
} else if (args.includes("--fetch")) {
  const d = candidates.find((candidate) => candidate.modelId === value("--fetch"));
  if (!d) { console.error("Unknown model identity"); process.exit(1); }
  line(d);
  if (!gate(d).allowed) process.exit(1);
  console.log("Plan only: no weights fetched. Use the explicit Advanced acquisition/import workflow; verify every language/projector pin before evaluation.");
} else {
  console.error("usage: fetch-lab-models.mjs --list | --plan [--channel benchmark|download|eval|bundle] | --fetch <modelId> [--channel benchmark]");
  process.exit(2);
}
