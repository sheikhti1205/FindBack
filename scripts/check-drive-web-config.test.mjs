import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkDriveWebConfig } from "./check-drive-web-config.mjs";

const CLIENT = "123456789012-syntheticclient.apps.googleusercontent.com";
test("Drive Web rejects absent and invalid public OAuth configuration", () => {
  assert.deepEqual(checkDriveWebConfig(undefined), { ok: false, reason: "missing" });
  assert.deepEqual(checkDriveWebConfig("android-client"), { ok: false, reason: "malformed" });
  assert.deepEqual(checkDriveWebConfig("GOCSPX-synthetic"), { ok: false, reason: "secret_material" });
  assert.deepEqual(checkDriveWebConfig(CLIENT), { ok: true });
});
test("Drive Web requires the configured audience in the actual shipped JavaScript", () => {
  assert.deepEqual(checkDriveWebConfig(CLIENT, []), { ok: false, reason: "missing_from_bundle" });
  assert.deepEqual(checkDriveWebConfig(CLIENT, ['const id="different-client"']), { ok: false, reason: "missing_from_bundle" });
  assert.deepEqual(checkDriveWebConfig(CLIENT, [`const id=${JSON.stringify(CLIENT)}`]), { ok: true });
});
