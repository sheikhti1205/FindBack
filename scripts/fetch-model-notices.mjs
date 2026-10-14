#!/usr/bin/env node
/** Fetch TEXT provenance/license/NOTICE only. Never fetch model binary bodies. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSupplyCandidates } from "./read-model-supply.mjs";

const sha = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
export function verifyTextBlob(bytes, sibling) {
  const blob = sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), "sha1");
  if (sibling?.lfs || sibling?.size !== bytes.length || sibling?.blobId !== blob) throw new Error("Pinned text blob identity mismatch");
}

async function boundedText(url, cap) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { Accept: "text/plain, application/json" } });
      break;
    } catch (error) { if (attempt === 2) throw error; }
  }
  if (!response.ok || !response.body || !response.url.startsWith("https://")) throw new Error("Public pinned text source unavailable");
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > cap) throw new Error("Text source exceeds byte cap");
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel(); }
  const body = Buffer.concat(chunks);
  new TextDecoder("utf-8", { fatal: true }).decode(body);
  return body;
}

export const PINNED_BASELINE_MODELS = [
  { modelId: "needle3-cact-l20", upstreamRepo: "Cactus-Compute/needle3", revision: "c7c415a3d1b3d929014bc6e866d51ebb971f7089", fileName: "needle3.cact", bytes: 35335380, sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38" },
  { modelId: "smolvlm2-500M-vision", upstreamRepo: "litert-community/SmolVLM2-500M", revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c", fileName: "SmolVLM2-500M.litertlm", bytes: 360822960, sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0" },
  { modelId: "qwen3-0.6b-dynamic-int4", upstreamRepo: "litert-community/Qwen3-0.6B", revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76", fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", bytes: 344671744, sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856" },
];

export async function collectModelNotices() {
  const documents = {}; const models = {}; const cache = new Map();
  // Reuse prior text snapshots only after byte/hash AND current pinned Git
  // blob verification. This is not an inventory or acquisition-pin shortcut.
  const textCache = new Map();
  try {
    const previous = JSON.parse(readFileSync(new URL("../docs/evidence/model-license-packet.json", import.meta.url), "utf8"));
    for (const [hash, value] of Object.entries(previous.documents ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(hash) || typeof value.text !== "string" || !Array.isArray(value.sources)) continue;
      const body = Buffer.from(value.text, "utf8");
      if (body.length !== value.bytes || sha(body) !== hash) continue;
      for (const source of value.sources) textCache.set(source, body);
    }
  } catch { /* No prior packet; all public text will be fetched. */ }
  const catalogue = [...PINNED_BASELINE_MODELS, ...readSupplyCandidates()];
  async function inventory(repo, revision) {
    const key = `${repo}@${revision}`;
    if (!cache.has(key)) {
      const data = JSON.parse((await boundedText(`https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`, 2 * 1024 ** 2)).toString("utf8"));
      if (data.id !== repo || data.sha !== revision || !Array.isArray(data.siblings)) throw new Error("Pinned repository inventory mismatch");
      cache.set(key, data);
    }
    return cache.get(key);
  }
  async function document(repo, revision, sibling) {
    if (!sibling || !/^[a-zA-Z0-9_./-]+$/.test(sibling.rfilename) || sibling.rfilename.split("/").includes("..")) throw new Error("Unsafe or missing pinned text path");
    const source = `https://huggingface.co/${repo}/raw/${revision}/${sibling.rfilename}`;
    const body = textCache.get(source) ?? await boundedText(source, 256 * 1024); verifyTextBlob(body, sibling);
    const hash = sha(body);
    documents[hash] ??= { bytes: body.length, sha256: hash, sources: [], text: body.toString("utf8") };
    if (!documents[hash].sources.includes(source)) documents[hash].sources.push(source);
    return { sha256: hash, source };
  }
  for (const d of catalogue) {
    console.log(`model notices: checking ${d.modelId}`);
    const data = await inventory(d.upstreamRepo, d.revision);
    for (const file of [d, ...(d.companions ?? [])]) {
      const sibling = data.siblings.find((s) => s.rfilename === file.fileName);
      if (sibling?.lfs?.sha256 !== file.sha256 || sibling?.size !== file.bytes) throw new Error("Catalogue artifact disagrees with pinned publisher metadata");
    }
    const card = await document(d.upstreamRepo, d.revision, data.siblings.find((s) => s.rfilename === "README.md"));
    const licenseSibling = data.siblings.find((s) => /^(LICENSE|LICENSE\.txt|LICENSE\.md)$/i.test(s.rfilename));
    let license;
    if (licenseSibling) license = await document(d.upstreamRepo, d.revision, licenseSibling);
    else if (d.modelId.startsWith("qwen3-") && !d.modelId.includes("vl")) {
      // Original publisher license when the conversion inventory lacks one.
      const repo = d.modelId.includes("1.7") ? "Qwen/Qwen3-1.7B" : "Qwen/Qwen3-0.6B";
      const revision = d.modelId.includes("1.7") ? "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e" : "c1899de289a04d12100db370d81485cdf75e47ca";
      const original = await inventory(repo, revision);
      license = await document(repo, revision, original.siblings.find((s) => s.rfilename === "LICENSE"));
    } else {
      if (d.upstreamRepo.includes("LFM") || data.cardData?.license !== "apache-2.0") throw new Error("No verified license declaration/text source");
      const source = "https://www.apache.org/licenses/LICENSE-2.0.txt";
      const body = textCache.get(source) ?? await boundedText(source, 32 * 1024);
      const hash = sha(body);
      if (hash !== "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30") throw new Error("Canonical Apache license text changed");
      documents[hash] ??= { bytes: body.length, sha256: hash, sources: [], text: body.toString("utf8") };
      if (!documents[hash].sources.includes(source)) documents[hash].sources.push(source);
      license = { source, sha256: hash };
    }
    const notices = [];
    for (const sibling of data.siblings.filter((s) => /notice/i.test(s.rfilename))) notices.push(await document(d.upstreamRepo, d.revision, sibling));
    models[d.modelId] = { upstreamRepo: d.upstreamRepo, revision: d.revision, artifacts: [d, ...(d.companions ?? [])].map((file) => ({ fileName: file.fileName, bytes: file.bytes, sha256: file.sha256 })), attribution: `Model artifact published by ${d.upstreamRepo}; exact pinned publisher card retained. FindBack does not modify the model bytes.`, license, card, notices,
      noticeInventory: notices.length ? "Pinned repository NOTICE files retained." : "No NOTICE filename in the pinned publisher inventory; this does not audit notices embedded in weights or native dependencies." };
  }
  return { schema: 1, models, documents };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const packet = await collectModelNotices();
    writeFileSync(new URL("../docs/evidence/model-license-packet.json", import.meta.url), JSON.stringify(packet, null, 2) + "\n");
    console.log(`model notices: verified ${Object.keys(packet.models).length} models; text only, no model bodies fetched`);
  } catch (error) {
    const safeReasons = ["Public pinned text source unavailable", "Text source exceeds byte cap", "Pinned text blob identity mismatch", "Pinned repository inventory mismatch", "Unsafe or missing pinned text path", "Catalogue artifact disagrees with pinned publisher metadata", "No verified license declaration/text source", "Canonical Apache license text changed"];
    const reason = safeReasons.includes(error?.message) ? error.message : "Text fetch/parse failed";
    console.error(`model notices: FAILED (${reason}); no packet written`); process.exitCode = 1;
  }
}
