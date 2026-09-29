#!/usr/bin/env node
/**
 * Tests for scripts/derive-publish-type.mjs.
 *
 * Run: `node --test scripts/derive-publish-type.test.mjs` from repo root.
 * Pure Node builtins.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { derivePublishType } from "./derive-publish-type.mjs";

const BETA_NOTES = "Prerelease signed beta. See release-manifest.json for versionCode, git SHA, and per-artifact checksums.";

describe("derivePublishType", () => {
  it("keeps v0.2.0-beta.1 behavior unchanged (prerelease + beta title + beta notes)", () => {
    const r = derivePublishType("v0.2.0-beta.1");
    assert.equal(r.prerelease, true);
    assert.equal(r.prereleaseFlag, "--prerelease");
    assert.equal(r.title, "FindBack v0.2.0-beta.1 (beta)");
    assert.equal(r.notes, BETA_NOTES);
  });

  it("treats other prerelease suffixes (-rc, -alpha) as prereleases", () => {
    for (const tag of ["v1.0.0-rc.1", "v1.0.0-alpha", "v2.3.4-beta.10"]) {
      const r = derivePublishType(tag);
      assert.equal(r.prerelease, true, tag);
      assert.equal(r.prereleaseFlag, "--prerelease", tag);
      assert.equal(r.title, `FindBack ${tag} (beta)`, tag);
      assert.equal(r.notes, BETA_NOTES, tag);
    }
  });

  it("publishes plain stable tags as normal releases with a stable title", () => {
    const r = derivePublishType("v1.0.0");
    assert.equal(r.prerelease, false);
    assert.equal(r.prereleaseFlag, "");
    assert.equal(r.title, "FindBack v1.0.0");
    assert.match(r.notes, /^Stable release\./);
    assert.match(r.notes, /release-manifest\.json/);
  });

  it("treats build metadata alone (+...) as stable, not prerelease", () => {
    assert.equal(derivePublishType("v1.0.0+42").prerelease, false);
  });

  it("rejects non-SemVer tags", () => {
    for (const bad of ["1.0.0", "v1.0", "vfoo", "", "release-1", "v1.0.0-"]) {
      assert.throws(() => derivePublishType(bad), /invalid release tag/, bad);
    }
  });
});
