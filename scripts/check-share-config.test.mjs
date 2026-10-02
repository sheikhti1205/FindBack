import { test } from "node:test";
import assert from "node:assert/strict";
import { validateShareOrigin, checkShareChunks } from "./check-share-config.mjs";

test("accepts a bare production HTTPS origin", () => {
  assert.equal(validateShareOrigin("https://findbackapp.social"), "https://findbackapp.social");
});
test("rejects local, non-HTTPS, credentials, paths, placeholders, and IP origins", () => {
  for (const origin of ["", "http://findback.test", "https://localhost", "https://foo.localhost", "https://127.0.0.1", "https://[::1]", "https://10.0.0.1", "file:///tmp", "capacitor://localhost", "https://u:p@findback.test", "https://findback.test/r", "https://findback.test?x=1", "https://findback.test#x", "https://example.com", "https://findback.local"]) {
    assert.throws(() => validateShareOrigin(origin), /share config/i, origin);
  }
});
test("requires the origin actually embedded in emitted JS", () => {
  const origin = "https://findback.test";
  assert.throws(() => checkShareChunks(["const x=1;"], origin), /missing/);
  assert.throws(() => checkShareChunks([], origin), /missing/);
  assert.doesNotThrow(() => checkShareChunks([`const origin=${JSON.stringify(origin)};`], origin));
});
