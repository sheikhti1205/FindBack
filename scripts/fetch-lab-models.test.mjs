import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { test } from "node:test";

function cli(args) { return spawnSync(process.execPath, [new URL("./fetch-lab-models.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" }); }
test("download plan allows exact-pinned conditional LFM acquisition without an eval-only license claim", () => {
  const result = cli(["--plan", "--channel", "download"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ALLOW lfm2-350m-q4_0/);
  assert.doesNotMatch(result.stdout, /benchmark\/eval-only/);
});
test("catalogue has real original GGUF and distinct successor identities, not invented LiteRT files", () => {
  const result = cli(["--list"]); assert.equal(result.status, 0);
  assert.match(result.stdout, /LiquidAI\/LFM2-VL-450M-GGUF\/LFM2-VL-450M-Q4_0\.gguf/);
  assert.match(result.stdout, /litert-community\/LFM2\.5-VL-450M\/LFM2\.5-VL-450M_int4_fixB\.litertlm/);
  assert.doesNotMatch(result.stdout, /LFM2-VL-450M-int4\.litertlm|pending-verification/);
});
test("an unknown channel is a usage failure, not authorization", () => {
  assert.equal(cli(["--plan", "--channel", "typo"]).status, 2);
});
