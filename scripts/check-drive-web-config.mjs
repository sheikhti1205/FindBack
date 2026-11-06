#!/usr/bin/env node
// OAuth client IDs are public configuration, never client secrets or tokens.
// Do not load env files: production Web must receive the value explicitly.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGoogleClientId } from "./check-google-config.mjs";

export function checkDriveWebConfig(value, assets) {
  const checked = validateGoogleClientId(value);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  if (assets !== undefined && !assets.some(text => text.includes(checked.clientId))) {
    return { ok: false, reason: "missing_from_bundle" };
  }
  return { ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--assets");
    const dir = index < 0 ? null : process.argv[index + 1];
    if (index >= 0 && !dir) throw new Error("assets directory required");
    const assets = dir === null ? undefined : readdirSync(dir)
      .filter(name => name.endsWith(".js"))
      .map(name => readFileSync(resolve(dir, name), "utf8"));
    const result = checkDriveWebConfig(process.env.VITE_GOOGLE_DRIVE_CLIENT_ID, assets);
    if (!result.ok) throw new Error(result.reason);
    console.log("Drive Web public configuration verified" + (dir ? " in bundle" : ""));
  } catch (error) {
    // Fixed reasons only: never print the supplied configuration or asset body.
    const allowed = ["missing", "malformed", "secret_material", "missing_from_bundle", "assets directory required"];
    console.error("Drive Web configuration: " + (allowed.includes(error.message) ? error.message : "assets_unreadable"));
    process.exitCode = 1;
  }
}
