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

  it("describes explicit verified Android installs and specialized offline tasks only", () => {
    for (const copy of [mobileCopy, edgeSummary]) {
      expect(copy).toMatch(/Android/);
      expect(copy).toMatch(/Needle/);
      expect(copy).toMatch(/checksum/);
      expect(copy).toMatch(/pause, resume|pause and resume/i);
      expect(copy).toMatch(/web.*(unavailable|does not)/i);
      // The retired generative runtimes and their benchmark controls must not
      // reappear in consumer copy.
      expect(copy).not.toMatch(/SmolVLM/);
      expect(copy).not.toMatch(/Measure (?:CPU|GPU)/);
      expect(copy).not.toMatch(/tokens per second/i);
    }
  });

  it("names the OpenRouter default route and the connected-provider architecture, without a retired price gate", () => {
    expect(APP_CAPABILITIES.aiConnection.join(" ")).toMatch(/openrouter\/free/i);
    expect(APP_CAPABILITIES.aiConnection.join(" ")).toMatch(/billed by your provider/i);
    expect(APP_CAPABILITIES.photoAnalysis.join(" ")).toMatch(/AI provider/i);
    expect(APP_CAPABILITIES.helpAssistant.join(" ")).toMatch(/AI provider/i);
    expect(APP_CAPABILITIES.privacy.join(" ")).toMatch(/provider you connect/i);
    expect(edgeSummary).toMatch(/openrouter\/free/i);
    // The retired free-only gate is the opposite of what ships: the model you
    // pick is billed by your provider. Neither copy may claim the gate again.
    for (const copy of [mobileCopy, edgeSummary]) {
      expect(copy).not.toMatch(/never switches to a paid model/i);
      expect(copy).not.toMatch(/free-only by default/i);
      expect(copy).not.toMatch(/free route by default/i);
    }
  });

  it("keeps report photos off the server until the user publishes", () => {
    expect(APP_CAPABILITIES.photoAnalysis.join(" ")).toMatch(/upload only when you publish/i);
    expect(APP_CAPABILITIES.privacy.join(" ")).toMatch(/until you publish/i);
  });

  it("states that photo analysis is not available instead of describing a retired engine", () => {
    const photoCopy = APP_CAPABILITIES.photoAnalysis.join(" ");
    expect(photoCopy).toMatch(/photo analysis isn't available/i);
    expect(photoCopy).toMatch(/no photo is sent to an AI provider/i);
    for (const copy of [photoCopy, edgeSummary]) {
      expect(copy).not.toMatch(/local-first/i);
      expect(copy).not.toMatch(/on-device-only/i);
      expect(copy).not.toMatch(/skips local inference/i);
      expect(copy).not.toMatch(/automatic mode/i);
      expect(copy).not.toMatch(/SmolVLM/);
      expect(copy).not.toMatch(/Measure (?:CPU|GPU)/);
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

describe("capability corpus containment", () => {
  it("has no production consumer, so its stale AI entries cannot reach a surface", () => {
    // The corpus is legacy text with no production consumer. Its AI entries
    // have been corrected, but nothing may start consuming it: the live
    // surfaces own their own copy.
    const srcRoot = join(repoRoot, "apps", "mobile", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (path.endsWith(join("services", "appCapabilities.ts"))) continue;
        if (path.endsWith(join("services", "appCapabilities.test.ts"))) continue;
        if (readFileSync(path, "utf8").includes("APP_CAPABILITIES")) offenders.push(path);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
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
