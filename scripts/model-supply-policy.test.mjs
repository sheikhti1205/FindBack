import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validatePromotion } from "./check-ai-promotion.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sources = {
  policySource: read("apps/mobile/src/services/ai/llama/promotionPolicy.ts"),
  licenseSource: read("apps/mobile/src/services/ai/llama/licenseGate.ts"),
  profilesSource: read("apps/mobile/src/services/ai/modelProfiles.ts"),
};

test("promotion gate permits conditional acquisition without equating it to product promotion", () => {
  assert.deepEqual(validatePromotion(sources), []);
});

test("promotion gate still refuses a removed model-weight bundle prohibition", () => {
  const licenseSource = sources.licenseSource.replace('if (channel === "bundle")', 'if (channel === "download")');
  assert.notEqual(licenseSource, sources.licenseSource);
  assert.ok(validatePromotion({ ...sources, licenseSource }).some((error) => error.includes("bundle")));
});
