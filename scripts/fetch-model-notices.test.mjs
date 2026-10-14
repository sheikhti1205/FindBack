import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyTextBlob } from "./fetch-model-notices.mjs";

test("verifies exact text bytes against the pinned Git blob, including CRLF", () => {
  const body = Buffer.from("License\r\n");
  const blobId = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest("hex");
  const sibling = { blobId, size: body.length };
  assert.doesNotThrow(() => verifyTextBlob(body, sibling));
  assert.throws(() => verifyTextBlob(Buffer.from("License\n"), sibling));
  assert.throws(() => verifyTextBlob(body, { ...sibling, lfs: {} }));
});
