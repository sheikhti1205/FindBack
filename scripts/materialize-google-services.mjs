#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FINDBACK_FIREBASE_PROJECT_ID } from "./firebase-project-id.mjs";

try {
  const encoded = process.env.GOOGLE_SERVICES_JSON_B64;
  if (!encoded) throw new Error("GOOGLE_SERVICES_JSON_B64 missing");
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (config.project_info?.project_id !== FINDBACK_FIREBASE_PROJECT_ID
      || !config.client?.some(client => client.client_info?.android_client_info?.package_name === "com.findback.app")
      || config.private_key || config.type === "service_account") throw new Error("unexpected Firebase client config");
  writeFileSync(resolve("apps/mobile/android/app/google-services.json"), `${JSON.stringify(config, null, 2)}\n`, {mode:0o600});
  if (process.argv.includes('--export-google-client')) {
    const client = config.client.find(c => c.client_info?.android_client_info?.package_name === 'com.findback.app');
    const ids = new Set((client.oauth_client ?? []).filter(c => c.client_type === 3).map(c => c.client_id));
    const id = [...ids][0];
    if (ids.size !== 1 || typeof id !== 'string' || !/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(id) || !process.env.GITHUB_ENV) throw Error();
    appendFileSync(process.env.GITHUB_ENV, `GOOGLE_WEB_CLIENT_ID=${id}\n`);
  }
  console.log("Firebase Android client configuration restored (project/package verified)");
} catch { console.error("Firebase client configuration missing or invalid; refusing Android build"); process.exitCode = 1; }
