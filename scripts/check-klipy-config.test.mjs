#!/usr/bin/env node
/**
 * Tests for scripts/check-klipy-config.mjs (X7 cross-environment parity).
 *
 * Run: `node --test scripts/check-klipy-config.test.mjs` from the repo root.
 * Node builtins only, hermetic. The single hard rule under test: the API key
 * VALUE must never appear anywhere in the probe's output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KLIPY_ENV_KEY, klipyStatus, klipyExitCode, formatKlipyReport } from "./check-klipy-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCRIPT = resolve(HERE, "check-klipy-config.mjs");

/** A value distinctive enough that any leak is unambiguous. */
const SECRET = "klipy-super-secret-key-DO-NOT-LEAK-9f3a";

describe("KLIPY_ENV_KEY", () => {
  it("is the VITE_-prefixed build seam", () => {
    assert.equal(KLIPY_ENV_KEY, "VITE_KLIPY_API_KEY");
  });

  it("matches the constant owned by the app adapter (parity, read-only)", () => {
    const src = readFileSync(resolve(ROOT, "apps/mobile/src/services/klipy.ts"), "utf8");
    const match = /KLIPY_BUILD_CONFIG_KEY\s*=\s*"([^"]+)"/.exec(src);
    assert.ok(match, "klipy.ts must declare KLIPY_BUILD_CONFIG_KEY");
    assert.equal(match[1], KLIPY_ENV_KEY);
  });
});

describe("klipyStatus", () => {
  it("reports ENABLED for a non-empty value", () => {
    assert.equal(klipyStatus({ [KLIPY_ENV_KEY]: SECRET }), "ENABLED");
  });

  it("trims: whitespace-only is DISABLED", () => {
    assert.equal(klipyStatus({ [KLIPY_ENV_KEY]: "   " }), "DISABLED");
  });

  it("reports DISABLED for blank, missing, or non-string values", () => {
    for (const env of [
      {},
      { [KLIPY_ENV_KEY]: "" },
      { [KLIPY_ENV_KEY]: undefined },
      { [KLIPY_ENV_KEY]: null },
      { [KLIPY_ENV_KEY]: 123 },
    ]) {
      assert.equal(klipyStatus(env), "DISABLED", `expected DISABLED for ${JSON.stringify(env)}`);
    }
  });
});

describe("klipyExitCode", () => {
  it("passes ENABLED and tolerated DISABLED", () => {
    assert.equal(klipyExitCode("ENABLED"), 0);
    assert.equal(klipyExitCode("DISABLED"), 0);
    assert.equal(klipyExitCode("DISABLED", { require: false }), 0);
  });

  it("fails DISABLED only under --require", () => {
    assert.equal(klipyExitCode("DISABLED", { require: true }), 1);
    assert.equal(klipyExitCode("ENABLED", { require: true }), 0);
  });
});

describe("formatKlipyReport never leaks the value", () => {
  it("prints only the name and the status token", () => {
    const line = formatKlipyReport("ENABLED", { require: true });
    assert.ok(line.includes(KLIPY_ENV_KEY));
    assert.ok(line.includes("ENABLED"));
    assert.ok(!line.includes(SECRET));
  });

  it("fails the --require line without carrying the value", () => {
    const line = formatKlipyReport("DISABLED", { require: true });
    assert.match(line, /FAIL/);
    assert.ok(line.includes(KLIPY_ENV_KEY));
    assert.ok(!line.includes(SECRET));
  });

  it("no formatted output (all modes) contains the value", () => {
    for (const status of ["ENABLED", "DISABLED"]) {
      for (const requireEnabled of [true, false]) {
        const line = formatKlipyReport(status, { require: requireEnabled });
        assert.ok(!line.includes(SECRET), `leak in ${status}/${requireEnabled}: ${line}`);
      }
    }
  });
});

describe("CLI (node scripts/check-klipy-config.mjs)", () => {
  function run(args, env) {
    try {
      const stdout = execFileSync("node", [SCRIPT, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        code: typeof error.status === "number" ? error.status : -1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
      };
    }
  }

  it("exits 0 DISABLED without --require, leaking nothing", () => {
    const result = run([], { [KLIPY_ENV_KEY]: "" });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("DISABLED"));
    assert.ok(!result.stdout.includes(SECRET));
  });

  it("exits 1 DISABLED under --require, leaking nothing", () => {
    const result = run(["--require"], { [KLIPY_ENV_KEY]: "" });
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes("FAIL"));
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
  });

  it("exits 0 ENABLED and never echoes the value", () => {
    const result = run(["--require"], { [KLIPY_ENV_KEY]: SECRET });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("ENABLED"));
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
  });

  it("rejects unknown flags with exit 2", () => {
    const result = run(["--bogus"], { [KLIPY_ENV_KEY]: SECRET });
    assert.equal(result.code, 2);
  });
});
