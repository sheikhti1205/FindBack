#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  const encoded = process.env.GOOGLE_SERVICES_JSON_B64;
  if (!encoded) throw new Error("GOOGLE_SERVICES_JSON_B64 missing");
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (config.project_info?.project_id !== "findback-mobile-app"
      || !config.client?.some(client => client.client_info?.android_client_info?.package_name === "com.findback.app")
      || config.private_key || config.type === "service_account") throw new Error("unexpected Firebase client config");
  writeFileSync(resolve("apps/mobile/android/app/google-services.json"), `${JSON.stringify(config, null, 2)}\n`, {mode:0o600});
  console.log("Firebase Android client configuration restored (project/package verified)");
} catch { console.error("Firebase client configuration missing or invalid; refusing Android build"); process.exitCode = 1; }
