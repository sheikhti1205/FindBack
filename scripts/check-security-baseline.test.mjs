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
  it("rejects invalid semver tails and numeric cores but accepts build metadata", () => {
    for (const value of ["1.2.3garbage", "01.2.3", "1.02.3", "1.2.03", "9007199254740992.0.0", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3-.."])
      assert.equal(parseVersion(value), null, value);
    assert.deepEqual(parseVersion("12.0.2+build.1"), { parts: [12, 0, 2], prerelease: null });
  });
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
  it("rejects malformed package maps instead of reporting a false PASS", () => {
    for (const packages of [undefined, null, [], "bad"]) assert.throws(() => findViolations(packages));
  });

  it("checks nested copies, path identities and aliased names despite misleading metadata", () => {
    const violations = findViolations({
      "node_modules/@graphql-tools/utils": { name: "unrelated", version: "12.0.1" },
      "node_modules/parent/node_modules/zod": { version: "4.6.6-rc.1" },
      "node_modules/alias": { name: "zod", version: "3.25.76" },
      "node_modules/vite": { version: "8.2.4+safe.build" },
    });
    assert.deepEqual(violations.map(v => v.path).sort(), [
      "node_modules/@graphql-tools/utils", "node_modules/alias", "node_modules/parent/node_modules/zod",
    ]);
  });
  it("rejects all newly observed vulnerable package lines, including nested development copies", () => {
    const vulnerable = {
      "node_modules/@graphql-tools/utils": { version: "12.0.1" },
      "node_modules/body-parser": { version: "2.3.0" },
      "node_modules/multer": { version: "2.4.0" },
      "node_modules/zod": { version: "3.25.76" },
      "node_modules/undici": { version: "8.10.2", dev: true },
      "node_modules/vitest": { version: "5.0.0", dev: true },
      "node_modules/vitest/node_modules/@vitest/mocker": { version: "5.0.0", dev: true },
      "node_modules/vite": { version: "8.2.2", dev: true },
    };
    assert.deepEqual(new Set(findViolations(vulnerable).map(v => v.package)), new Set([
      "@graphql-tools/utils", "body-parser", "multer", "zod", "undici", "vitest", "@vitest/mocker", "vite",
    ]));
  });

  it("rejects malformed or missing versions of a security-baselined package", () => {
    for (const version of ["12.0.2garbage", "99.0.0junk", "workspace:*", undefined]) {
      assert.equal(findViolations({ "node_modules/@graphql-tools/utils": { version } }).length, 1);
    }
  });
  const packages = {
    "": { name: "findback", version: "0.9.0-beta.1" },
    "node_modules/@graphql-tools/utils": { version: "12.0.2" },
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
    assert.equal(utils?.cve, "CVE-2026-114604");
  });

  it("passes once all copies reach the fixed version", () => {
    const fixed = {
      "node_modules/@graphql-tools/utils": { version: "12.0.2" },
      "node_modules/sharp": { version: "0.35.5" },
    };
    assert.deepEqual(findViolations(fixed), []);
  });

  it("ignores unrelated packages, not malformed security-baselined ones", () => {
    assert.deepEqual(
      findViolations({
        "node_modules/graphql-yoga": { version: "5.24.2" },
        services: { version: "0.1.0" },
      }),
      [],
    );
  });
});
