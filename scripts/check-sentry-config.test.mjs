#!/usr/bin/env node
/**
 * TDD RED-first tests for scripts/check-sentry-config.mjs (S1).
 *
 * Run: `node --test scripts/check-sentry-config.test.mjs` from the repo root.
 * No dependencies beyond Node builtins. Never prints key material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  validateSentryDsn,
  loadSentryFileEnv,
  validateSentryTraceRate,
  loadTraceRateFileEnv,
  checkEffectiveTraceRate,
  SENTRY_DSN_PATTERN_HINT,
} from "./check-sentry-config.mjs";

const VALID = "https://abc123def456@o123456.ingest.sentry.io/7890123";

describe("validateSentryDsn", () => {
  it("accepts a well-formed https DSN and reports shapes only", () => {
    const result = validateSentryDsn(VALID);
    assert.equal(result.ok, true);
    assert.equal(result.host, "o123456.ingest.sentry.io");
    assert.equal(result.projectId, "7890123");
    assert.ok(result.keyLen > 0);
    // The key itself must never be echoed back.
    assert.ok(!JSON.stringify(result).includes("abc123def456"));
  });

  it("exposes the expected DSN shape hint", () => {
    assert.match(SENTRY_DSN_PATTERN_HINT, /https:\/\//);
  });

  it("rejects missing and empty values", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${String(raw)}`);
      assert.equal(result.reason, "missing");
    }
  });

  it("rejects non-https and non-URL values", () => {
    for (const raw of [
      "not-a-url",
      "http://abc123@o123.ingest.sentry.io/456",
      "ftp://abc123@o123.ingest.sentry.io/456",
      "//abc123@o123.ingest.sentry.io/456",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "malformed");
    }
  });

  it("rejects DSNs with missing key, host, or project id", () => {
    for (const raw of [
      "https://@o123.ingest.sentry.io/456",
      "https:///456",
      "https://abc123@/456",
      "https://abc123@o123.ingest.sentry.io/",
      "https://abc123@o123.ingest.sentry.io",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
    }
  });

  it("rejects placeholder values", () => {
    for (const raw of [
      "https://changeme@o123.ingest.sentry.io/456",
      "https://example@o123.ingest.sentry.io/456",
      "https://abc123@example.com/456",
      "https://abc123@changeme/456",
      "https://test@o123.ingest.sentry.io/456",
      "https://abc123@o123.ingest.sentry.io/example",
    ]) {
      const result = validateSentryDsn(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "placeholder");
    }
  });
});

describe("loadSentryFileEnv (same source Vite embeds)", () => {
  it("reads VITE_SENTRY_DSN from the mobile env dir like import.meta.env does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    try {
      await writeFile(join(dir, ".env.production"), `VITE_SENTRY_DSN=${VALID}\n`);
      assert.equal(loadSentryFileEnv("production", dir), VALID);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns undefined when no env file provides a DSN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    const prev = process.env.VITE_SENTRY_DSN;
    delete process.env.VITE_SENTRY_DSN;
    try {
      assert.equal(loadSentryFileEnv("production", dir), undefined);
    } finally {
      if (prev !== undefined) process.env.VITE_SENTRY_DSN = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("prefers exported shell values over env files (Vite precedence)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-env-"));
    const prev = process.env.VITE_SENTRY_DSN;
    await writeFile(join(dir, ".env.production"), `VITE_SENTRY_DSN=${VALID}\n`);
    process.env.VITE_SENTRY_DSN = "https://shellkey@o9.ingest.sentry.io/99";
    try {
      assert.equal(
        loadSentryFileEnv("production", dir),
        "https://shellkey@o9.ingest.sentry.io/99",
      );
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_DSN;
      else process.env.VITE_SENTRY_DSN = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("trace-rate validation (canonical build-context owner)", () => {
  it("defaults to the code-conservative 0.1 when empty (never 1.0 in code)", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, true);
      assert.equal(result.rate, 0.1);
      assert.notEqual(result.rate, 1.0, "maximum comes from env, never code");
    }
  });

  it("accepts explicit 0..1 values, including the runbook maximum 1.0", () => {
    assert.deepEqual(validateSentryTraceRate("1.0"), { ok: true, rate: 1, source: "explicit" });
    assert.deepEqual(validateSentryTraceRate("0"), { ok: true, rate: 0, source: "explicit" });
  });

  it("rejects NaN and out-of-range values fail-closed", () => {
    for (const raw of ["abc", "NaN"]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "nan");
    }
    for (const raw of ["-0.1", "1.5"]) {
      const result = validateSentryTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "out-of-range");
    }
  });

  it("loads VITE_SENTRY_TRACES_SAMPLE_RATE from the mobile env dir like Vite embeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-rate-"));
    const prev = process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    try {
      await writeFile(join(dir, ".env.production"), "VITE_SENTRY_TRACES_SAMPLE_RATE=0.5\n");
      assert.equal(loadTraceRateFileEnv("production", dir), "0.5");
      assert.deepEqual(checkEffectiveTraceRate({ mode: "production", mobileDir: dir }), {
        ok: true,
        rate: 0.5,
        source: "explicit",
      });
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
      else process.env.VITE_SENTRY_TRACES_SAMPLE_RATE = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to the 0.1 default when no env file provides a rate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "findback-sentry-rate-"));
    const prev = process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
    try {
      assert.equal(loadTraceRateFileEnv("production", dir), undefined);
      const result = checkEffectiveTraceRate({ mode: "production", mobileDir: dir });
      assert.equal(result.ok, true);
      assert.equal(result.rate, 0.1);
    } finally {
      if (prev === undefined) delete process.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
      else process.env.VITE_SENTRY_TRACES_SAMPLE_RATE = prev;
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("SENTRY_AUTH_TOKEN never appears as a value in repo files", () => {
  it("no tracked file assigns SENTRY_AUTH_TOKEN (comments/docs allowed)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..");
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const hits = [];
    for (const file of files) {
      if (/(^|\/)(node_modules|\.git|dist|build|\.gradle)\//.test(file)) continue;
      if (!/\.(ts|tsx|js|mjs|cjs|json|md|gradle|java|kt|xml|yml|yaml|env|properties|toml)$/.test(file))
        continue;
      let text;
      try {
        text = execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, encoding: "utf8" });
      } catch {
        continue;
      }
      // Built at runtime so this very file carries no scannable literal (self-match).
      const viteTokenPattern = new RegExp(["VITE", "SENTRY_AUTH_TOKEN"].join("_"));
      if (viteTokenPattern.test(text)) hits.push(`${file}: VITE_-prefixed token (would leak to client)`);
      // An actual assignment with a value (not a bare comment mention).
      // GitHub `${{ secrets.* }}` / `${{ vars.* }}` references are safe —
      // they resolve at runtime from the secret store, never a literal.
      const assign = text.match(/SENTRY_AUTH_TOKEN\s*[:=]\s*(["']?)([^\s"'#]+)\1/);
      if (assign && assign[2] && !/^(<.*>|\[.*\]|""|'')$/.test(assign[2]) && !assign[2].startsWith("${{")) {
        hits.push(`${file}: assigns SENTRY_AUTH_TOKEN`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
