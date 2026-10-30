import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const read = path => readFileSync(resolve(root, path), "utf8");

const nativeModelCommandsAreCheckOnly = source => source.split("\n")
  .filter(line => !line.trimStart().startsWith("#") && /fetch-(?:use|needle)-model\.mjs/.test(line))
  .every(line => /^\s*(?:run:\s*)?node scripts\/fetch-use-model\.mjs --check\s*$/.test(line));

test("native model-command guard allows USE verification but rejects explicit weight acquisition", () => {
  assert.ok(nativeModelCommandsAreCheckOnly("        run: node scripts/fetch-use-model.mjs --check"));
  assert.ok(nativeModelCommandsAreCheckOnly("        run: |\n          node scripts/fetch-use-model.mjs --check"));
  for (const command of ["node scripts/fetch-use-model.mjs", "node scripts/fetch-needle-model.mjs", "node scripts/fetch-needle-model.mjs --check", "node scripts/fetch-use-model.mjs --check || node scripts/fetch-use-model.mjs"]) {
    assert.equal(nativeModelCommandsAreCheckOnly(`        run: ${command}`), false, command);
    assert.equal(nativeModelCommandsAreCheckOnly(`        run: |\n          ${command}`), false, command);
  }
});

test("beta README describes shipped peer messaging separately from cloud AI Chat", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /Coming next[\s\S]*Private chat|When private chat ships|Sign in with email, phone verification/i);
  assert.match(readme, /private messages/i);
  assert.match(readme, /not end-to-end encrypted/i);
  assert.match(readme, /temporar(?:y|ily)[^.]*deliver/i);
  assert.match(readme, /safety[^.]*retain|retain[^.]*safety/i);
  assert.doesNotMatch(readme, /^path: \/home\//m);
});

test("capability mirrors and grounded knowledge no longer deny shipped messaging", () => {
  for (const path of ["apps/mobile/src/services/appCapabilities.ts", "supabase/functions/ai-help/capabilities.ts", "apps/mobile/src/services/ai/appKnowledge.ts"]) {
    const source = read(path);
    assert.doesNotMatch(source, /label: "private messaging"|Not available: private messaging/, path);
    assert.match(source, /private messag/i, path);
  }
});

test("retired lab workflow is not an executable CI queue; useful model/native checks remain", () => {
  assert.equal(existsSync(resolve(root, ".github/workflows/local-ai-lab.yml")), false);
  const smoke = read(".github/workflows/local-ai-model-smoke.yml");
  for (const invariant of ["fetch-use-model.mjs --check", "fetch-needle-model.mjs --check", "scan:apk -- --strict", "ai-release-gate.mjs", "check-mobile-build-config.mjs --assets"]) assert.ok(smoke.includes(invariant), invariant);
  const native = read(".github/workflows/local-ai-native.yml");
  assert.match(native, /:app:compileDebugSources :app:testDebugUnitTest/);
  assert.match(native, /check-mobile-build-config\.mjs --assets/);
  assert.ok(nativeModelCommandsAreCheckOnly(native), "native explicit model commands are USE checks only, not downloads");
  assert.match(native, /Gradle preBuild may fetch the pinned bundled USE asset/);
  assert.doesNotMatch(native, /NEVER downloads model weights|no model downloads|must stay download-free/i);
});

test("retained native workflows invoke the supported config preflight before building", () => {
  for (const path of [".github/workflows/local-ai-native.yml", ".github/workflows/local-ai-model-smoke.yml"]) {
    const source = read(path);
    const build = source.indexOf("npm run build -w @findback/mobile");
    assert.ok(build > 0, path);
    const preflight = [...source.matchAll(/^\s*node scripts\/check-mobile-build-config\.mjs(.*)$/gm)]
      .find(match => match.index < build);
    assert.ok(preflight, path);
    assert.equal(preflight[1].trim(), "--preflight", `${path}: checker requires its explicit preflight action`);
  }
});
