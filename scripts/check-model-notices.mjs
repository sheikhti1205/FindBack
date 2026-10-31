import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A legal snapshot, not an executable model catalogue. Historical notices stay
// byte-identical; only the retained optional tool needs an acquisition identity.
export const RETAINED_MODEL_NOTICE_IDENTITY = Object.freeze({
  modelId: "needle3-cact-l20", upstreamRepo: "Cactus-Compute/needle3",
  revision: "c7c415a3d1b3d929014bc6e866d51ebb971f7089",
  fileName: "needle3.cact", bytes: 35335380,
  sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
});

/** Text digests, citation references and all exact artifact identities fail closed. */
export function validateModelNotices(packet, candidates) {
  const errors = [];
  if (packet?.schema !== 1 || !packet.models || !packet.documents) return ["missing model notice packet"];
  for (const [hash, document] of Object.entries(packet.documents)) {
    const text = typeof document?.text === "string" ? Buffer.from(document.text, "utf8") : undefined;
    if (!text || document.bytes !== text.length || hash !== document.sha256 || createHash("sha256").update(text).digest("hex") !== hash || !Array.isArray(document.sources)) errors.push(`snapshot byte identity mismatch: ${hash}`);
  }
  for (const [id, model] of Object.entries(packet.models)) {
    if (!Array.isArray(model.notices) || !model.attribution || !model.noticeInventory) { errors.push(`missing attribution/NOTICE inventory: ${id}`); continue; }
    for (const reference of [model.license, model.card, ...model.notices]) {
      const document = reference && packet.documents[reference.sha256];
      if (!document || !document.sources?.includes(reference.source)) errors.push(`missing cited snapshot: ${id}`);
    }
  }
  for (const d of candidates) {
    const model = packet.models[d.modelId];
    if (!model || model.upstreamRepo !== d.upstreamRepo || model.revision !== d.revision) { errors.push(`missing/stale model provenance: ${d.modelId}`); continue; }
    const artifacts = [d, ...(d.companions ?? [])].map((f) => ({ fileName: f.fileName, bytes: f.bytes, sha256: f.sha256 }));
    if (JSON.stringify(model.artifacts) !== JSON.stringify(artifacts)) errors.push(`stale artifact identity: ${d.modelId}`);
  }
  return errors;
}

export function checkModelNoticesFile() {
  try {
    return validateModelNotices(JSON.parse(readFileSync(new URL("../docs/history/model-lab/evidence/model-license-packet.json", import.meta.url), "utf8")), [RETAINED_MODEL_NOTICE_IDENTITY]);
  } catch { return ["missing or malformed historical legal snapshot"]; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkModelNoticesFile();
  if (errors.length) { console.error(`model notices: FAIL (${errors.join("; ")})`); process.exitCode = 1; }
  else console.log("model notices: PASS (exact text digests, attribution/NOTICE references and artifact identities)");
}
