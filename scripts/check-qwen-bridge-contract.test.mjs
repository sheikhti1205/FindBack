#!/usr/bin/env node
/**
 * Tests for scripts/check-qwen-bridge-contract.mjs.
 *
 * Run: `node --test scripts/check-qwen-bridge-contract.test.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContract } from "./check-qwen-bridge-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const TS_OK = `
export const QWEN_TEXT_PLUGIN_NAME = "FindbackQwenText" as const;
interface FindbackQwenTextPlugin {
  loadTextModel(args: { modelId: string; installedPath?: string; maxTokens: number }): Promise<{ ready: boolean }>;
  addListener(name: "qwenTextChunk", callback: (event: never) => void): Promise<never>;
}
interface QwenTextRequest {
  readonly generationId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}
const listener = await plugin.addListener("qwenTextChunk", handler);
`;

const KT_OK = `
@CapacitorPlugin(name = "FindbackQwenText")
class QwenTextPlugin : Plugin() {
    fun loadTextModel(call: PluginCall) {
        val sessionMax = QwenTextPolicy.clampSessionMaxTokens(call.getInt("maxTokens"))
    }
    fun generateText(call: PluginCall) {
        val callMax = QwenTextPolicy.clampCallMaxTokens(call.getInt("maxOutputTokens"), sessionMax)
        notifyGeneration(generationId!!, delta = text, done = true)
    }
    private fun notifyGeneration(generationId: String, delta: String?) {
        notifyListeners("qwenTextChunk", event)
    }
}
`;

test("matching sources pass", () => {
  assert.deepEqual(checkContract({ ts: TS_OK, kt: KT_OK }), []);
});

test("plugin name mismatch fails", () => {
  const kt = KT_OK.replace("FindbackQwenText", "FindbackQwen");
  const errors = checkContract({ ts: TS_OK, kt });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /plugin name mismatch/);
});

test("event mismatch fails", () => {
  const kt = KT_OK.replace("qwenTextChunk", "textChunk");
  const errors = checkContract({ ts: TS_OK, kt });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /event mismatch/);
});

test("load field mismatch fails", () => {
  const kt = KT_OK.replace('call.getInt("maxTokens")', 'call.getInt("maxOutputTokens")');
  const errors = checkContract({ ts: TS_OK, kt });
  assert.ok(errors.some((e) => /load field mismatch/.test(e)));
});

test("generate field mismatch fails", () => {
  const kt = KT_OK.replace('call.getInt("maxOutputTokens")', 'call.getInt("maxTokens")');
  const errors = checkContract({ ts: TS_OK, kt });
  assert.ok(errors.some((e) => /generate field mismatch/.test(e)));
});

test("live tree agrees (drift guard)", () => {
  const ts = readFileSync(
    resolve(REPO_ROOT, "apps/mobile/src/services/ai/text/litertLmText.ts"),
    "utf8",
  );
  const kt = readFileSync(
    resolve(
      REPO_ROOT,
      "apps/mobile/android/app/src/main/java/com/findback/app/ai/QwenTextPlugin.kt",
    ),
    "utf8",
  );
  assert.deepEqual(checkContract({ ts, kt }), []);
});
