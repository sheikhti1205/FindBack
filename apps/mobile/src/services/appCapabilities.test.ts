import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_CAPABILITIES, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "./appCapabilities";

// The server-side mirror lives outside the Vite root, so compare by source:
// the contract is strict version parity + accurate, platform-scoped product facts.
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
 * Unsupported claims remain forbidden even with the new downloadable Android runtimes.
 */
const RETIRED_CLAIMS: Array<[RegExp, string]> = [
  [/\b256M\b/, "256M model"],
  [/wi-fi only/i, "Wi-Fi-only downloads"],
  [/GPU (is |always )?faster/i, "unmeasured GPU speed"],
  [/no downloadable or offline generative model/i, "retired architecture"],
  [
    /(photo|image|picture)[^.]{0,60}never (sent|leaves)[^.]{0,30}(server|device|phone)/i,
    "photo never leaves the device",
  ],
  [/help answers come from this server/i, "server-side Help"],
];

describe("capability docs", () => {
  it("stays in sync with the server-side mirror", () => {
    const match = edgeSource.match(/CAPABILITIES_VERSION = "([^"]+)"/);
    expect(match?.[1]).toBe(CAPABILITIES_VERSION);
  });

  it("avoids unsupported speed, privacy and retired-architecture claims", () => {
    for (const [pattern, label] of RETIRED_CLAIMS) {
      expect(pattern.test(mobileCopy), `mobile capability copy still claims ${label}`).toBe(false);
      expect(pattern.test(edgeSummary), `server capability copy still claims ${label}`).toBe(false);
    }
  });

  it("describes explicit verified Android installs, specialized offline tasks and measurement limits", () => {
    for (const copy of [mobileCopy, edgeSummary]) {
      expect(copy).toMatch(/Android/);
      expect(copy).toMatch(/Needle/);
      expect(copy).toMatch(/SmolVLM2/);
      expect(copy).toMatch(/checksum/);
      expect(copy).toMatch(/pause and resume/i);
      expect(copy).toMatch(/CPU/);
      expect(copy).toMatch(/measurement/);
      expect(copy).toMatch(/web.*(unavailable|does not)/i);
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

  it("states local-first photo analysis with on-device-only/cloud-only semantics", () => {
    const photoCopy = APP_CAPABILITIES.photoAnalysis.join(" ");
    expect(photoCopy).toMatch(/local-first/i);
    expect(photoCopy).toMatch(/SmolVLM2/);
    expect(photoCopy).toMatch(/automatic mode/i);
    expect(photoCopy).toMatch(/fall ?back/i);
    expect(photoCopy).toMatch(/on-device-only/i);
    expect(photoCopy).toMatch(/cloud-only/i);
    expect(photoCopy).toMatch(/never sends the photo to/i);
    expect(photoCopy).toMatch(/skips local inference/i);
    for (const copy of [photoCopy, edgeSummary]) {
      expect(copy).toMatch(/local-first/i);
      expect(copy).toMatch(/on-device-only/i);
      expect(copy).toMatch(/cloud-only/i);
    }
  });

  it("never describes a removed inference-mode selector", () => {
    expect(mobileCopy).not.toMatch(/\bAUTO\b|\bQUALITY\b/);
    expect(edgeSummary).not.toMatch(/Model modes: AUTO/);
  });

  it("describes post feedback as reactions on both mirrors (W1-A FBX-035)", () => {
    const socialCopy = APP_CAPABILITIES.social.join(" ");
    expect(socialCopy).toMatch(/one reaction per user/i);
    expect(socialCopy).not.toMatch(/like or dislike/i);
    const inboxCopy = APP_CAPABILITIES.notifications.join(" ");
    expect(inboxCopy).toMatch(/inbox for reactions, comments, mentions/i);
    expect(inboxCopy).not.toMatch(/likes, dislikes/i);
    expect(edgeSummary).toMatch(/one reaction per user/i);
    expect(edgeSummary).toMatch(/inbox for reactions, comments, mentions/i);
    expect(edgeSummary).not.toMatch(/one like\/dislike per user/);
    expect(edgeSummary).not.toMatch(/inbox for likes, dislikes/);
  });
});

describe("backend schema version parity", () => {
  it("matches the newest data-contract migration prefix (About/Diagnostics never go stale)", () => {
    const migrations = readdirSync(join(repoRoot, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0);
    const newest = migrations
      .map((name) => name.match(/^(\d{14})_/)?.[1])
      .filter((prefix): prefix is string => prefix !== undefined)
      .sort()
      .at(-1);
    expect(newest).toBeDefined();
    // Landing a new migration without bumping the advertised version fails
    // here instead of shipping stale About/Diagnostics metadata.
    expect(BACKEND_SCHEMA_VERSION).toBe(newest);
  });
});
