#!/usr/bin/env node
/**
 * Qwen text bridge wire-contract guard (reviewer FAIL → fix-forward).
 *
 * The TS binding (`apps/mobile/src/services/ai/text/litertLmText.ts`) and the
 * native plugin (`.../app/ai/QwenTextPlugin.kt`) must agree on four wire
 * strings or Qwen text is dead on arrival: Capacitor `registerPlugin(name)`
 * resolves no module when the names differ, and `addListener(event)` never
 * fires when the event names differ. The green vitest suite cannot catch this
 * (it fakes the bridge at the interface level), so this file-level check is
 * the drift guard. Fails closed; prints names only (no secrets involved).
 *
 * Usage:
 *   node scripts/check-qwen-bridge-contract.mjs   # checks the real tree
 *
 * Pure Node builtins. Test suite: scripts/check-qwen-bridge-contract.test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TS_PATH = "apps/mobile/src/services/ai/text/litertLmText.ts";
const KT_PATH =
  "apps/mobile/android/app/src/main/java/com/findback/app/ai/QwenTextPlugin.kt";

function firstGroup(text, regex) {
  const match = regex.exec(text);
  return match ? match[1] : null;
}

/**
 * Pure contract core. All inputs are plain source text so this is
 * unit-testable without the repo tree. Returns failure strings (empty = pass).
 */
export function checkContract({ ts, kt }) {
  const errors = [];
  const tsPlugin = firstGroup(ts, /QWEN_TEXT_PLUGIN_NAME\s*=\s*"([^"]+)"/);
  const ktPlugin = firstGroup(kt, /@CapacitorPlugin\s*\(\s*name\s*=\s*"([^"]+)"/);
  if (!tsPlugin) errors.push("TS QWEN_TEXT_PLUGIN_NAME not found");
  if (!ktPlugin) errors.push("Kotlin @CapacitorPlugin name not found");
  if (tsPlugin && ktPlugin && tsPlugin !== ktPlugin) {
    errors.push(
      `plugin name mismatch: TS registers "${tsPlugin}" but native exposes "${ktPlugin}"`,
    );
  }
  const tsEvent = firstGroup(ts, /addListener\(\s*"([^"]+)"/);
  const ktEvent = firstGroup(kt, /notifyListeners\(\s*"([^"]+)"\s*,\s*event\s*\)/);
  if (!tsEvent) errors.push("TS addListener event not found");
  if (!ktEvent) errors.push("Kotlin notifyListeners event not found");
  if (tsEvent && ktEvent && tsEvent !== ktEvent) {
    errors.push(
      `event mismatch: TS listens "${tsEvent}" but native emits "${ktEvent}"`,
    );
  }
  const tsLoad = firstGroup(ts, /loadTextModel\(args:\s*\{([^}]*)\}/);
  const tsRequest = firstGroup(ts, /interface QwenTextRequest \{([^}]*)\}/);
  const [ktLoad = "", ktGenerate = ""] = kt.split("fun generateText");
  const ktLoadKeys = [...ktLoad.matchAll(/call\.getInt\("([^"]+)"\)/g)].map((m) => m[1]);
  const ktGenKeys = [...ktGenerate.matchAll(/call\.getInt\("([^"]+)"\)/g)].map((m) => m[1]);
  if (!tsLoad || !tsLoad.includes("maxTokens")) {
    errors.push("TS loadTextModel args must carry maxTokens");
  } else if (!ktLoadKeys.includes("maxTokens")) {
    errors.push(
      `load field mismatch: TS sends maxTokens but native load reads [${ktLoadKeys.join(", ")}]`,
    );
  }
  if (!tsRequest || !tsRequest.includes("maxOutputTokens")) {
    errors.push("TS QwenTextRequest must carry maxOutputTokens");
  } else if (!ktGenKeys.includes("maxOutputTokens")) {
    errors.push(
      `generate field mismatch: TS sends maxOutputTokens but native generate reads [${ktGenKeys.join(", ")}]`,
    );
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ts = readFileSync(resolve(REPO_ROOT, TS_PATH), "utf8");
    const kt = readFileSync(resolve(REPO_ROOT, KT_PATH), "utf8");
    const errors = checkContract({ ts, kt });
    if (errors.length > 0) {
      for (const error of errors) console.error(`check-qwen-bridge-contract: ${error}`);
      process.exitCode = 1;
    } else {
      console.log("check-qwen-bridge-contract: PASS (plugin, event, load/generate fields agree)");
    }
  } catch {
    console.error("check-qwen-bridge-contract: cannot read bridge sources");
    process.exitCode = 1;
  }
}
