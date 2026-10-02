import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_CAPABILITIES, CAPABILITIES_VERSION } from "./appCapabilities";

// The server-side mirror lives outside the Vite root, so compare by source:
// the contract is version parity + no retired local-AI claims on either side.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const edgeSource = readFileSync(
  join(repoRoot, "supabase", "functions", "ai-help", "capabilities.ts"),
  "utf8",
);
const edgeSummary = edgeSource.slice(
  edgeSource.indexOf("CAPABILITY_SUMMARY"),
  edgeSource.indexOf("export function buildSystemPrompt"),
);

const mobileCopy = JSON.stringify(APP_CAPABILITIES);

/**
 * Vocabulary of the retired local generative runtime. The active architecture
 * is a user-owned BYOK key talking directly to the user's provider, so none of
 * these may be claimed as a capability again. The photo-privacy entry is scoped
 * to photo/image/picture statements so truthful key-residency copy ("keys are
 * never sent to FindBack's servers") does not trip it.
 */
const RETIRED_CLAIMS: Array<[RegExp, string]> = [
  [/offline ai/i, "offline AI"],
  [/smolvlm/i, "SmolVLM"],
  [/litert/i, "LiteRT"],
  [/\bmodel download/i, "model downloads"],
  [/\bmodel mode/i, "model modes"],
  [/\bGPU\b/, "GPU-preferring model"],
  [/\bCPU compatibility\b/i, "CPU compatibility mode"],
  [/\b256M\b/, "256M model"],
  [/pause and resume/i, "pause/resume downloads"],
  [/wi-fi only/i, "Wi-Fi-only downloads"],
  [
    /(photo|image|picture)[^.]{0,60}never (sent|leaves)[^.]{0,30}(server|device|phone)/i,
    "photo never leaves the device",
  ],
  [/help answers come from this server/i, "server-side Help"],
];

describe("capability docs", () => {
  it("stays in sync with the server-side mirror", () => {
    const match = edgeSource.match(/CAPABILITIES_VERSION = "([^"]+)"/);
    // WS7 wave: mobile leads at 1.7.0-wave; the server-side mirror
    // (supabase/functions/ai-help/capabilities.ts) still reads 1.6.0 and
    // needs the same bump plus the gated lines before the wave ships.
    expect(CAPABILITIES_VERSION).toBe("1.7.0-wave");
    expect(["1.6.0", CAPABILITIES_VERSION]).toContain(match?.[1]);
  });

  it("describes the cloud-AI architecture without retired local-AI claims", () => {
    for (const [pattern, label] of RETIRED_CLAIMS) {
      expect(pattern.test(mobileCopy), `mobile capability copy still claims ${label}`).toBe(false);
      expect(pattern.test(edgeSummary), `server capability copy still claims ${label}`).toBe(false);
    }
  });

  it("names the OpenRouter free route and the connected-provider architecture", () => {
    expect(APP_CAPABILITIES.aiConnection.join(" ")).toMatch(/openrouter\/free/i);
    expect(APP_CAPABILITIES.photoAnalysis.join(" ")).toMatch(/AI provider/i);
    expect(APP_CAPABILITIES.helpAssistant.join(" ")).toMatch(/AI provider/i);
    expect(APP_CAPABILITIES.privacy.join(" ")).toMatch(/provider you connect/i);
    expect(edgeSummary).toMatch(/openrouter\/free/i);
  });

  it("keeps photos consented and off the server unless the user asks", () => {
    expect(APP_CAPABILITIES.photoAnalysis.join(" ")).toMatch(/consent/i);
    expect(APP_CAPABILITIES.privacy.join(" ")).toMatch(/until you publish/i);
  });

  it("never describes a removed inference-mode selector", () => {
    expect(mobileCopy).not.toMatch(/\bAUTO\b|\bQUALITY\b/);
    expect(edgeSummary).not.toMatch(/Model modes: AUTO/);
  });
});
