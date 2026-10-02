#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
try {
  const root = process.argv[2] || "apps/mobile/dist";
  const links = JSON.parse(readFileSync(resolve(root, ".well-known/assetlinks.json"), "utf8"));
  const pin = (process.env.ANDROID_SIGNING_CERT_SHA256 || "").replace(/:/g, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error("release signing fingerprint missing");
  const match = links.some(link => link.relation?.includes("delegate_permission/common.handle_all_urls")
    && link.target?.namespace === "android_app" && link.target.package_name === "com.findback.app"
    && link.target.sha256_cert_fingerprints?.some(value => value.replace(/:/g, "").toLowerCase() === pin));
  if (!match) throw new Error("assetlinks does not match release signing pin");
  const config = JSON.parse(readFileSync(resolve(root, "staticwebapp.config.json"), "utf8"));
  if (!config.navigationFallback?.exclude?.includes("/.well-known/*")) throw new Error("association must not fall back to HTML");
  console.log("Web association: PASS (release certificate pin; package; no HTML fallback)");
} catch (error) { console.error(`Web association: FAIL (${error.message})`); process.exitCode = 1; }
