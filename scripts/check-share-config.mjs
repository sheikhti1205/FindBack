#!/usr/bin/env node
import { isIP } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

export function validateShareOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("share config: missing or invalid VITE_PUBLIC_SHARE_ORIGIN"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port
      || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")
      || /(^|\.)(localhost|local|internal|example\.(com|org|net))$/.test(host)) {
    throw new Error("share config: origin must be bare public HTTPS (no local hosts, IPs, paths, credentials or placeholders)");
  }
  return url.origin;
}

export function effectiveShareOrigin(mode = "production") {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  return validateShareOrigin(loadEnv(mode, root, "").VITE_PUBLIC_SHARE_ORIGIN?.trim() || "");
}

export function checkShareChunks(chunks, origin) {
  if (!chunks.some(chunk => chunk.includes(origin))) throw new Error("share config: public origin missing from bundle");
}

export function checkShareAssets(path, origin = effectiveShareOrigin()) {
  checkShareChunks(readdirSync(path).filter(name => name.endsWith(".js")).map(name => readFileSync(resolve(path, name), "utf8")), origin);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const origin = effectiveShareOrigin();
    if (process.argv[2] === "--assets") checkShareAssets(process.argv[3], origin);
    else if (process.argv[2] && !["--preflight", "--hostname"].includes(process.argv[2])) throw new Error("share config: expected --preflight, --hostname or --assets PATH");
    console.log(process.argv[2] === "--hostname" ? new URL(origin).hostname : `check-share-config: PASS (${origin})`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
