#!/usr/bin/env node
/**
 * Tests for scripts/check-security-baseline.mjs.
 *
 * Run: `node --test scripts/check-security-baseline.test.mjs` from repo root.
 * Pure Node builtins. Never touches the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compareVersions,
  findViolations,
  packageNameFromPath,
  parseVersion,
} from "./check-security-baseline.mjs";

describe("parseVersion / compareVersions", () => {
  it("orders plain semver numerically, not lexically", () => {
    assert.equal(compareVersions("12.0.1", "12.0.0"), 1);
    assert.equal(compareVersions("11.2.2", "12.0.1"), -1);
    assert.equal(compareVersions("9.2.4", "10.0.0"), -1);
    assert.equal(compareVersions("12.0.1", "12.0.1"), 0);
  });
  it("sorts a prerelease below its release", () => {
    assert.equal(compareVersions("12.0.1-beta.1", "12.0.1"), -1);
    assert.equal(compareVersions("12.0.1", "12.0.1-beta.1"), 1);
  });
  it("returns null for unparseable versions", () => {
    assert.equal(parseVersion("workspace:*"), null);
    assert.equal(parseVersion(undefined), null);
  });
});

describe("packageNameFromPath", () => {
  it("resolves a hoisted path", () => {
    assert.equal(packageNameFromPath("node_modules/@graphql-tools/utils"), "@graphql-tools/utils");
  });
  it("resolves a nested path to the innermost package", () => {
    assert.equal(
      packageNameFromPath("node_modules/@graphql-tools/executor/node_modules/@graphql-tools/utils"),
      "@graphql-tools/utils",
    );
  });
  it("returns null for a non-install path", () => {
    assert.equal(packageNameFromPath("services/api"), null);
  });
});

describe("findViolations", () => {
  const packages = {
    "": { name: "findback", version: "0.9.0-beta.1" },
    "node_modules/@graphql-tools/utils": { version: "12.0.1" },
    "node_modules/@graphql-tools/executor/node_modules/@graphql-tools/utils": { version: "11.2.2" },
    "node_modules/sharp": { version: "0.35.4" },
    "node_modules/@graphql-tools/schema": { version: "10.1.1" },
  };

  it("flags every installed copy below the fixed version", () => {
    const violations = findViolations(packages);
    const found = violations.map((v) => `${v.package}@${v.version}`).sort();
    assert.deepEqual(found, ["@graphql-tools/utils@11.2.2", "sharp@0.35.4"]);
  });

  it("names the CVE in the @graphql-tools/utils violation", () => {
    const utils = findViolations(packages).find((v) => v.package === "@graphql-tools/utils");
    assert.equal(utils?.cve, "CVE-2026-104852");
  });

  it("passes once all copies reach the fixed version", () => {
    const fixed = {
      "node_modules/@graphql-tools/utils": { version: "12.0.1" },
      "node_modules/sharp": { version: "0.35.5" },
    };
    assert.deepEqual(findViolations(fixed), []);
  });

  it("ignores unrelated packages and missing versions", () => {
    assert.deepEqual(
      findViolations({
        "node_modules/graphql-yoga": { version: "5.24.2" },
        "node_modules/@graphql-tools/utils": {},
        services: { version: "0.1.0" },
      }),
      [],
    );
  });
});
