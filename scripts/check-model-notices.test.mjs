import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateModelNotices, RETAINED_MODEL_NOTICE_IDENTITY } from "./check-model-notices.mjs";
const packet = JSON.parse(readFileSync(new URL("../docs/history/model-lab/evidence/model-license-packet.json", import.meta.url), "utf8"));
const candidates = [RETAINED_MODEL_NOTICE_IDENTITY];

test("all historical text snapshots and the retained tool identity pass", () => { assert.deepEqual(validateModelNotices(packet, candidates), []); });
test("corrupted license text fails rather than retaining a trusted snapshot label", () => {
  const broken = structuredClone(packet); const key = Object.keys(broken.documents)[0];
  broken.documents[key].text += "altered";
  assert.ok(validateModelNotices(broken, candidates).some((e) => e.includes("snapshot")));
});
test("changing a companion under the same primary model id invalidates the packet", () => {
  const broken = structuredClone(candidates);
  broken[0].companions = [{ fileName: "unexpected.bin", bytes: 20, sha256: "a".repeat(64) }];
  assert.ok(validateModelNotices(packet, broken).some((e) => e.includes("artifact")));
});
test("missing applicable NOTICE text fails closed", () => {
  const broken = structuredClone(packet); broken.models[candidates[0].modelId].notices.push({ source: "https://example.org/NOTICE", sha256: "a".repeat(64) });
  assert.ok(validateModelNotices(broken, candidates).some((e) => e.includes("missing")));
});
