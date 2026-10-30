import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("public screenshots have verified PNG identities and explicit fixture scope", () => {
  const path = "docs/screenshots/manifest.json";
  assert.ok(existsSync(path), "public screenshot provenance is missing");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.scope, "browser fixtures with synthetic reports; not native-device or real-account acceptance");
  assert.match(manifest.rendererVerifiedAtSource, /^[0-9a-f]{40}$/);
  assert.equal(manifest.images.length, 2);
  for (const image of manifest.images) {
    assert.match(image.file, /^[a-z-]+\.png$/);
    const bytes = readFileSync(`docs/screenshots/${image.file}`);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), image.width);
    assert.equal(bytes.readUInt32BE(20), image.height);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), image.sha256);
  }
});

test("README labels synthetic captures and provides descriptive image alternatives", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.ok(readme.includes("Browser captures with synthetic reports"));
  assert.match(readme, /src="docs\/screenshots\/search-light\.png"[^>]+alt="[^"]{20,}"/);
  assert.match(readme, /src="docs\/screenshots\/search-black\.png"[^>]+alt="[^"]{20,}"/);
});

test("CI runs the public screenshot integrity regression", () => {
  assert.ok(/run: node --test[^\n]*scripts\/public-screenshots\.test\.mjs/.test(
    readFileSync(".github/workflows/ci.yml", "utf8")));
});
