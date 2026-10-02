import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

test("FCM sync accepts only the dedicated sender and valid private key", async () => {
  const { fcmSecretValues } = await import("./sync-fcm-secrets.mjs");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sender = {
    type: "service_account",
    project_id: "findback-mobile-app",
    client_email: "findback-push@findback-mobile-app.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const input = {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sender),
    SUPABASE_PROJECT_REF: "nfjhpigbsyyoaaktfaev",
    VITE_PUBLIC_SHARE_ORIGIN: "https://ambitious-wave-0f1b6c500.3.azurestaticapps.net",
  };
  assert.deepEqual(fcmSecretValues(input), {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sender),
    FCM_PROJECT_ID: "findback-mobile-app",
    PUBLIC_SHARE_ORIGIN: "https://ambitious-wave-0f1b6c500.3.azurestaticapps.net",
  });
  for (const change of [
    { project_id: "wrong-project" },
    { client_email: "other@findback-mobile-app.iam.gserviceaccount.com" },
    { type: "authorized_user" },
    { private_key: "not a key" },
  ]) {
    assert.throws(() => fcmSecretValues({ ...input, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...sender, ...change }) }));
  }
  assert.throws(() => fcmSecretValues({ ...input, SUPABASE_PROJECT_REF: "-" }));
  assert.throws(() => fcmSecretValues({ ...input, VITE_PUBLIC_SHARE_ORIGIN: "http://localhost" }));
  assert.throws(() => fcmSecretValues({ ...input, FIREBASE_SERVICE_ACCOUNT_JSON: "" }));
});

test("FCM sync requires matching server digests for every stored value", async () => {
  const { verifyFcmDigests } = await import("./sync-fcm-secrets.mjs");
  const values = { FCM_PROJECT_ID: "findback-mobile-app" };
  // Independently computed SHA-256 of findback-mobile-app.
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update("findback-mobile-app").digest("hex");
  assert.doesNotThrow(() => verifyFcmDigests([{ name: "FCM_PROJECT_ID", value: digest }], values));
  assert.throws(() => verifyFcmDigests([{ name: "FCM_PROJECT_ID", value: "wrong" }], values));
  assert.throws(() => verifyFcmDigests([], values));
});
