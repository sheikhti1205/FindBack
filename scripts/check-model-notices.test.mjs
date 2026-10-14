import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readSupplyCandidates } from "./read-model-supply.mjs";
import { validateModelNotices } from "./check-model-notices.mjs";
const packet = JSON.parse(readFileSync(new URL("../docs/evidence/model-license-packet.json", import.meta.url), "utf8"));
const candidates = readSupplyCandidates();

test("all exact source snapshots and acquisition identities pass", () => { assert.deepEqual(validateModelNotices(packet, candidates), []); });
test("corrupted license text fails rather than retaining a trusted snapshot label", () => {
  const broken = structuredClone(packet); const key = Object.keys(broken.documents)[0];
  broken.documents[key].text += "altered";
  assert.ok(validateModelNotices(broken, candidates).some((e) => e.includes("snapshot")));
});
test("changing a companion under the same primary model id invalidates the packet", () => {
  const broken = structuredClone(candidates); broken.find((d) => d.companions).companions[0].sha256 = "a".repeat(64);
  assert.ok(validateModelNotices(packet, broken).some((e) => e.includes("artifact")));
});
test("missing applicable NOTICE text fails closed", () => {
  const broken = structuredClone(packet); broken.models[candidates[0].modelId].notices.push({ source: "https://example.org/NOTICE", sha256: "a".repeat(64) });
  assert.ok(validateModelNotices(broken, candidates).some((e) => e.includes("missing")));
});
