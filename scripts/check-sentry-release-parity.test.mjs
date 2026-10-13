#!/usr/bin/env node
/**
 * TDD tests for scripts/check-sentry-release-parity.mjs (CLOSEOUT-8).
 *
 * Green on the clean tree; red cases run checkParity() against a minimal
 * fixture root (copies of the real scanned files, one tampered per case).
 * Never prints values — shapes and file:line evidence only.
 *
 * Run: `node --test scripts/check-sentry-release-parity.test.mjs` from root.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkParity } from "./check-sentry-release-parity.mjs";

const SCANNED = [
  "apps/mobile/src/services/monitoring/release.ts",
  "apps/mobile/vite.config.ts",
  ".github/workflows/release.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/web.yml",
  "Dockerfile",
  "docker-compose.yml",
  "scripts/build-context.mjs",
  "scripts/build-apk.mjs",
  "scripts/check-sentry-config.mjs",
  "scripts/check-release-config.mjs",
  "scripts/check-mobile-build-config.mjs",
];

/** Fixture root with real scanned files; tamper() rewrites one file. */
function fixtureRoot(tamper) {
  const dir = mkdtempSync(join(tmpdir(), "findback-parity-"));
  try {
    for (const rel of SCANNED) {
      const dest = join(dir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, readFileSync(rel, "utf8"));
    }
    mkdirSync(join(dir, "apps/mobile/src"), { recursive: true });
    if (tamper) tamper(dir);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test("passes on the real tree (one scheme, one dist map, one cli pin)", () => {
  assert.deepEqual(checkParity(), []);
});

test("fails closed on every tampered contract", () => {
  const cases = [
    ["release.ts SHA drift", (d) => writeFileSync(join(d, "apps/mobile/src/services/monitoring/release.ts"),
      readFileSync("apps/mobile/src/services/monitoring/release.ts", "utf8").replace("{12}", "{7,40}")),
      /release\.ts.*exactly-12/],
    ["workflow shape drift", (d) => writeFileSync(join(d, ".github/workflows/ci.yml"),
      readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("{12}$", "{7,40}$")),
      /ci\.yml.*\{7,40\}/],
    ["second namespace", (d) => writeFileSync(join(d, "scripts/check-sentry-config.mjs"),
      `${readFileSync("scripts/check-sentry-config.mjs", "utf8")}\n// findback-web@1.0.0+790f45698fb4\n`),
      /second release namespace/],
    ["missing upload dist", (d) => writeFileSync(join(d, ".github/workflows/web.yml"),
      readFileSync(".github/workflows/web.yml", "utf8").replace("--dist web-production", "--dist erased")),
      /upload --dist web-production missing/],
    ["token gains VITE_ prefix", (d) => writeFileSync(join(d, "Dockerfile"),
      `${readFileSync("Dockerfile", "utf8")}\n# VITE_SENTRY_AUTH_TOKEN must never exist\n`),
      /VITE_ prefix/],
  ];
  for (const [name, tamper, pattern] of cases) {
    const dir = fixtureRoot(tamper);
    try {
      const failures = checkParity(dir);
      assert.ok(failures.length > 0, `${name}: expected at least one failure`);
      assert.ok(failures.some((f) => pattern.test(f)), `${name}: no failure matching ${pattern} in ${JSON.stringify(failures)}`);
      assert.ok(!JSON.stringify(failures).includes("790f45698fb4"), `${name}: sha value leaked`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
