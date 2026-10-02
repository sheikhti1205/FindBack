#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateShareOrigin } from "./check-share-config.mjs";

export function fcmSecretValues(env) {
  if (!/^[a-z]{20}$/.test(env.SUPABASE_PROJECT_REF || "")) throw new Error("invalid Supabase project reference");
  const sender = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
  if (sender?.type !== "service_account" || sender.project_id !== "findback-mobile-app"
      || sender.client_email !== "findback-push@findback-mobile-app.iam.gserviceaccount.com") {
    throw new Error("invalid dedicated FCM sender");
  }
  if (createPrivateKey(sender.private_key).asymmetricKeyType !== "rsa") throw new Error("invalid FCM private key");
  return {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sender),
    FCM_PROJECT_ID: sender.project_id,
    PUBLIC_SHARE_ORIGIN: validateShareOrigin(env.VITE_PUBLIC_SHARE_ORIGIN || ""),
  };
}

export function verifyFcmDigests(secrets, values) {
  for (const [name, value] of Object.entries(values)) {
    const digest = createHash("sha256").update(value).digest("hex");
    if (!secrets.some(secret => secret.name === name && (secret.digest || secret.value) === digest)) {
      throw new Error("server secret digest mismatch");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let directory;
  try {
    const values = fcmSecretValues(process.env);
    directory = mkdtempSync(resolve(tmpdir(), "findback-fcm-"));
    const path = resolve(directory, "secrets.env");
    const lines = Object.entries(values).map(([name, value]) => {
      if (value.includes("'") || /[\r\n]/.test(value)) throw new Error("invalid env-file value");
      return `${name}='${value}'`;
    });
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    const cli = resolve(fileURLToPath(new URL("../node_modules/.bin/supabase", import.meta.url)));
    const project = ["--project-ref", process.env.SUPABASE_PROJECT_REF];
    const set = spawnSync(cli, ["secrets", "set", ...project, "--env-file", path], { encoding: "utf8" });
    if (set.status !== 0) throw new Error("Supabase secret storage failed");
    const list = spawnSync(cli, ["secrets", "list", ...project, "--output", "json"], { encoding: "utf8" });
    if (list.status !== 0) throw new Error("Supabase secret verification failed");
    verifyFcmDigests(JSON.parse(list.stdout), values);
    console.log("FCM server secrets: PASS (sender, project and public origin digests matched)");
  } catch {
    // Never print credential input, CLI output, or parser diagnostics.
    console.error("FCM server secret synchronization failed; check credentials and project configuration");
    process.exitCode = 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
