import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lab isolation boundary: the static benchmark lane must never touch
 * production-lane modules. This test scans the lab source files (not
 * itself) for parent imports and forbidden identifiers.
 */
const LAB_SOURCES = [
  "benchmarkCandidateSchema.ts",
  "benchmarkDownloadGate.ts",
  "benchmarkCorpusDef.ts",
  "benchmarkResourceHooks.ts",
  "benchmarkRunner.ts",
  "benchmarkResultLogger.ts",
  "benchmarkScoreCalculator.ts",
  "benchmarkReport.ts",
  "benchmarkCactusIsolation.ts",
] as const;

const FORBIDDEN_IDENTIFIERS = [
  "orchestrator",
  "router",
  "picker",
  "modeldescriptors",
  "modelprofiles",
  "modelcatalog",
  "productionruntimes",
  "runtimeregistry",
  "recommend",
] as const;

function readLabSource(name: string): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, name), "utf8");
}

describe("benchmarkLab isolation boundary", () => {
  it("imports nothing outside the lab lane", () => {
    for (const name of LAB_SOURCES) {
      const text = readLabSource(name);
      expect(text, name).not.toMatch(/from\s+["']\.\.\//);
      expect(text, name).not.toMatch(/\brequire\s*\(/);
    }
  });

  it("names no production-lane module or pick flag", () => {
    for (const name of LAB_SOURCES) {
      const lowered = readLabSource(name).toLowerCase();
      for (const forbidden of FORBIDDEN_IDENTIFIERS) {
        expect(lowered, `${name} mentions ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the candidate file free of any production pick surface", () => {
    const text = readLabSource("benchmarkCandidateSchema.ts");
    expect(text).toMatch(/measured: false/);
    expect(text.toLowerCase()).not.toContain("autodownload");
    expect(text.toLowerCase()).not.toContain("auto-download");
  });
});
