import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSupplyCandidates } from "./read-model-supply.mjs";

test("preserves separate language/projector identity and publisher revision", () => {
  const input = 'export const SUPPLY_CANDIDATES = [candidate("vision", "Vision", "Publisher/Model", "revision", "model.gguf", 12, "hash", 1200, true, artifact("Publisher/Model", "revision", "mmproj.gguf", 13, "projectorhash"))];';
  assert.deepEqual(parseSupplyCandidates(input), [{ modelId: "vision", displayName: "Vision", upstreamRepo: "Publisher/Model", revision: "revision", fileName: "model.gguf", bytes: 12, sha256: "hash", minRamMb: 1200, vision: true, companions: [{ upstreamRepo: "Publisher/Model", revision: "revision", fileName: "mmproj.gguf", bytes: 13, sha256: "projectorhash" }] }]);
});
test("never evaluates executable expressions from catalogue source", () => {
  assert.throws(() => parseSupplyCandidates('export const SUPPLY_CANDIDATES = [candidate("id", "Name", "Repo/Model", "rev", "file.gguf", process.exit(0), "sha", 1200)];'));
});
