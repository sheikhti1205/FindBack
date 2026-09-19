import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_CAPABILITIES, CAPABILITIES_VERSION } from "./appCapabilities";

// The edge-function mirror lives outside the Vite root, so compare by source:
// the contract is version parity + no stale mode-selector claims on either side.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const edgeSource = readFileSync(
  join(repoRoot, "supabase", "functions", "ai-help", "capabilities.ts"),
  "utf8",
);

describe("capability docs (WP18 #16)", () => {
  it("stays in sync with the edge-function mirror", () => {
    const match = edgeSource.match(/CAPABILITIES_VERSION = "([^"]+)"/);
    expect(match?.[1]).toBe(CAPABILITIES_VERSION);
  });

  it("never describes the removed inference-mode selector", () => {
    expect(APP_CAPABILITIES.modelModes.join("\n")).not.toMatch(/AUTO|QUALITY/);
    expect(edgeSource).not.toMatch(/Model modes: AUTO/);
  });
});
