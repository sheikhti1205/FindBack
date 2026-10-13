#!/usr/bin/env node
/**
 * Tests for scripts/sentry-cross-lane-proof.mjs (X12).
 *
 * Run: `node --test scripts/sentry-cross-lane-proof.test.mjs` from the repo
 * root. Node builtins only, hermetic. The two hard rules under test: the
 * SENTRY_AUTH_TOKEN value and the DSN credential must never appear in any
 * output; the release must be exactly-12 hex and the dist from the closed set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENTRY_DIST_VALUES,
  SENTRY_RELEASE_SHAPE,
  buildCrossLaneProof,
  countSourcemaps,
  formatProof,
  resolveDsnHost,
  resolveLaneDist,
  resolveRelease,
  uploadStatus,
} from "./sentry-cross-lane-proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "sentry-cross-lane-proof.mjs");

const VERSION = "1.2.3";
const SHA12 = "0123456789ab";
const TOKEN = "sntrys-super-secret-token-DO-NOT-LEAK-77c1";
const DSN_KEY = "deadbeefcafe1234567890";
const DSN = `https://${DSN_KEY}@o4507.ingest.sentry.io/4507`;
const DSN_HOST = "o4507.ingest.sentry.io";

describe("resolveRelease — exactly-12 hex", () => {
  it("derives the canonical shape from version + short12", () => {
    const result = resolveRelease({ version: VERSION, short12: SHA12 });
    assert.equal(result.ok, true);
    assert.equal(result.release, `findback-mobile@${VERSION}+${SHA12}`);
    assert.match(result.release, SENTRY_RELEASE_SHAPE);
    assert.equal(/\+([0-9a-f]{12})$/i.exec(result.release)[1].length, 12);
  });

  it("accepts a baked release only when it is exactly-12 hex shaped", () => {
    assert.equal(resolveRelease({ env: { SENTRY_RELEASE: `findback-mobile@1.0.0+${SHA12}` } }).ok, true);
    for (const bad of [
      "findback-mobile@1.0.0+short",
      `findback-mobile@1.0.0+${SHA12}extra`,
      "findback-web@1.0.0+0123456789ab",
      "",
    ]) {
      const result = resolveRelease({ env: { SENTRY_RELEASE: bad } });
      if (bad === "") {
        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing-identity");
      } else {
        assert.equal(result.ok, false, `expected reject: ${bad}`);
        assert.equal(result.reason, "malformed");
      }
    }
  });

  it("rejects 11- and 13-hex SHAs (exact length policy)", () => {
    for (const sha of ["0123456789a", "0123456789abc"]) {
      const result = resolveRelease({ version: VERSION, short12: sha });
      assert.equal(result.ok, false, `expected reject: ${sha}`);
      assert.equal(result.reason, "invalid-identity");
    }
  });
});

describe("resolveLaneDist — closed set", () => {
  it("accepts every canonical dist and rejects everything else", () => {
    for (const dist of SENTRY_DIST_VALUES) {
      const result = resolveLaneDist({ env: { SENTRY_DIST: dist } });
      assert.equal(result.ok, true, `expected accept: ${dist}`);
      assert.equal(result.dist, dist);
    }
    for (const bad of ["production", "web", "android", "android-release-x", ""]) {
      const result = resolveLaneDist({ env: { SENTRY_DIST: bad } });
      assert.equal(result.ok, false, `expected reject: ${bad}`);
    }
  });

  it("prefers an explicit lane over the env value", () => {
    const result = resolveLaneDist({ dist: "android-release", env: { SENTRY_DIST: "bogus" } });
    assert.equal(result.ok, true);
    assert.equal(result.dist, "android-release");
  });
});

describe("resolveDsnHost — host only", () => {
  it("reduces a DSN to its hostname and never the key", () => {
    const result = resolveDsnHost(DSN);
    assert.equal(result.ok, true);
    assert.equal(result.host, DSN_HOST);
    assert.ok(!JSON.stringify(result).includes(DSN_KEY));
  });

  it("rejects a missing or malformed DSN", () => {
    for (const bad of [undefined, null, "", "not-a-dsn", "http://k@h/1"]) {
      assert.equal(resolveDsnHost(bad).ok, false, `expected reject: ${String(bad)}`);
    }
  });
});

describe("countSourcemaps + uploadStatus", () => {
  it("counts only what the injectable lister returns", () => {
    assert.equal(countSourcemaps("/x", { listFiles: () => ["a.map", "b.map", "c.map"] }).count, 3);
    assert.equal(countSourcemaps("/x", { listFiles: () => [] }).count, 0);
    assert.equal(countSourcemaps(null).count, 0);
  });

  it("never throws when the lister throws", () => {
    assert.equal(
      countSourcemaps("/x", {
        listFiles: () => {
          throw new Error("boom");
        },
      }).count,
      0,
    );
  });

  it("derives readiness from token presence + map count", () => {
    assert.equal(uploadStatus(true, 3), "READY");
    assert.equal(uploadStatus(true, 0), "NO-MAPS");
    assert.equal(uploadStatus(false, 3), "NO-TOKEN");
    assert.equal(uploadStatus(false, 0), "NO-TOKEN");
  });
});

describe("buildCrossLaneProof + formatProof never leak credentials", () => {
  function proof() {
    return buildCrossLaneProof({
      env: {
        SENTRY_AUTH_TOKEN: TOKEN,
        VITE_SENTRY_DSN: DSN,
        SENTRY_DIST: "web-production",
        SENTRY_RELEASE: `findback-mobile@${VERSION}+${SHA12}`,
      },
      artifactPath: "/build/dist",
      version: VERSION,
      short12: SHA12,
      listFiles: () => ["index.js.map", "vendor.js.map"],
    });
  }

  it("produces coherent, credential-free fields", () => {
    const result = proof();
    assert.deepEqual(result.errors, []);
    assert.equal(result.release, `findback-mobile@${VERSION}+${SHA12}`);
    assert.equal(result.dist, "web-production");
    assert.equal(result.dsnHost, DSN_HOST);
    assert.equal(result.maps, 2);
    assert.equal(result.uploadStatus, "READY");
  });

  it("neither the token nor the DSN key appears in the object JSON", () => {
    const json = JSON.stringify(proof());
    assert.ok(!json.includes(TOKEN), "token leaked into proof object");
    assert.ok(!json.includes(DSN_KEY), "DSN key leaked into proof object");
  });

  it("neither the token nor the DSN key appears in the formatted output", () => {
    const text = formatProof(proof());
    assert.ok(!text.includes(TOKEN), "token leaked into output");
    assert.ok(!text.includes(DSN_KEY), "DSN key leaked into output");
    // Only the five allowed labels are printed.
    for (const label of ["release:", "dist:", "dsn-host:", "maps:", "upload:"]) {
      assert.ok(text.includes(label), `missing label ${label}`);
    }
  });

  it("reports a baked-vs-derived release mismatch", () => {
    const result = buildCrossLaneProof({
      env: { SENTRY_RELEASE: "findback-mobile@9.9.9+ffffffffffff", SENTRY_DIST: "android-debug" },
      version: VERSION,
      short12: SHA12,
      listFiles: () => [],
    });
    assert.ok(result.errors.some((e) => e.includes("mismatch")));
  });

  it("flags a bad dist/dsn without echoing values", () => {
    const result = buildCrossLaneProof({
      env: { SENTRY_AUTH_TOKEN: TOKEN, VITE_SENTRY_DSN: DSN, SENTRY_DIST: "not-a-lane", SENTRY_RELEASE: "" },
      version: VERSION,
      short12: SHA12,
      listFiles: () => [],
    });
    assert.ok(result.errors.some((e) => e.startsWith("dist ")));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(DSN_KEY));
  });
});

describe("CLI (node scripts/sentry-cross-lane-proof.mjs)", () => {
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

  it("prints the five fields and never the token/DSN key", () => {
    const result = run(["--asset", resolve(HERE, "does-not-exist")], {
      SENTRY_AUTH_TOKEN: TOKEN,
      VITE_SENTRY_DSN: DSN,
      VITE_SENTRY_DIST: "web-production",
      VITE_SENTRY_RELEASE: "",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("release:"));
    assert.ok(result.stdout.includes("dsn-host:"));
    assert.ok(!result.stdout.includes(TOKEN));
    assert.ok(!result.stdout.includes(DSN_KEY));
    assert.ok(!result.stderr.includes(TOKEN));
  });

  it("exits 1 on an unknown lane without leaking the token", () => {
    const result = run(["--asset", resolve(HERE, "does-not-exist")], {
      SENTRY_AUTH_TOKEN: TOKEN,
      VITE_SENTRY_DSN: DSN,
      VITE_SENTRY_DIST: "nope",
      VITE_SENTRY_RELEASE: "",
    });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("dist"));
    assert.ok(!result.stderr.includes(TOKEN));
    assert.ok(!result.stdout.includes(TOKEN));
  });
});
