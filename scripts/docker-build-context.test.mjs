import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Docker build context includes the model licence packet consumed by mobile", () => {
  const source = readFileSync("apps/mobile/src/services/ai/modelLicenses.ts", "utf8");
  assert.match(source, /import packet from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/docs\/evidence\/model-license-packet\.json"/);
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const copy = "COPY docs/evidence/model-license-packet.json docs/evidence/model-license-packet.json";
  assert.ok(dockerfile.includes(copy), "mobile typecheck needs the licence packet inside the image build stage");
  assert.ok(dockerfile.indexOf(copy) < dockerfile.indexOf("RUN npm run build -w @findback/shared"));
  assert.doesNotThrow(() => JSON.parse(readFileSync("docs/evidence/model-license-packet.json", "utf8")));
});

test("CI includes the Docker context regression in its script gate", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.ok(/run: node --test[^\n]*scripts\/docker-build-context\.test\.mjs/.test(ci),
    "the explicit CI script list must run the Docker context regression");
});

test("Docker context retains only the native map-config source required by the web preflight", () => {
  const ignore = readFileSync(".dockerignore", "utf8").split(/\r?\n/);
  assert.ok(!ignore.includes("apps/mobile/android"), "an excluded parent hides the required Gradle input");
  for (const rule of ["apps/mobile/android/*", "!apps/mobile/android/app/",
    "apps/mobile/android/app/*", "!apps/mobile/android/app/build.gradle"]) {
    assert.ok(ignore.includes(rule), `missing narrow Docker context rule: ${rule}`);
  }
  const gradle = readFileSync("apps/mobile/android/app/build.gradle", "utf8");
  assert.ok(gradle.includes('System.getenv("FINDBACK_MAP_STYLE_URL")'));
  const owner = readFileSync("scripts/check-map-config.mjs", "utf8");
  assert.ok(owner.includes('"apps/mobile/android/app/build.gradle"'));
});
