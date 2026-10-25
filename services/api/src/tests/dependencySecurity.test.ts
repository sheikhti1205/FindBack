import { describe, expect, it } from "vitest";
import { mergeDeep, mergeIncrementalResult } from "@graphql-tools/utils";
import { z } from "zod";

/**
 * FBA-038 regression guard (dependency security).
 *
 * graphql-yoga previously resolved `@graphql-tools/utils@11.2.2`, whose
 * `mergeDeep` was vulnerable to prototype pollution
 * (CVE-2026-104852 / GHSA-7mx3-vvmw-hjmv). The root npm override pins the
 * current `12.0.2` (including the earlier `12.0.1` mergeDeep fix); this proves
 * the *installed* copy ignores `__proto__` and
 * `constructor.prototype` payloads instead of only trusting the lockfile.
 *
 * `mergeDeep` is public API (not an internal), so this is a legitimate
 * behavioral regression test, not a white-box reach into private internals.
 */
describe("dependency security — @graphql-tools/utils mergeDeep (CVE-2026-104852)", () => {
  it("does not pollute Object.prototype from a __proto__ payload", () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    mergeDeep([{}, payload]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("does not pollute Object.prototype from a constructor.prototype payload", () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    const payload = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
    mergeDeep([{}, payload]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

describe("dependency security — incremental GraphQL path coercion", () => {
  it.each([
    [["__proto__"], "cf020Polluted"],
    ["constructor", "prototype", "cf020Polluted"],
    [["constructor"], ["prototype"], "cf020Polluted"],
  ])("rejects prototype traversal through path %j", (...path) => {
    const prototype = Object.prototype as Record<string, unknown>;
    try {
      mergeIncrementalResult({
        incrementalResult: JSON.parse(JSON.stringify({ path, data: "synthetic" })),
        executionResult: { data: {} },
      });
      expect(Object.hasOwn(prototype, "cf020Polluted")).toBe(false);
    } finally { delete prototype.cf020Polluted; }
  });

  it("still merges valid incremental results", () => {
    const executionResult = { data: { report: { title: "umbrella" } } };
    mergeIncrementalResult({ incrementalResult: { path: ["report"], data: { category: "OTHER" } }, executionResult });
    expect(executionResult.data.report).toEqual({ title: "umbrella", category: "OTHER" });
  });
});

describe("dependency security — bounded collection validation", () => {
  it("rejects an oversized constrained collection before expanding per-element errors", () => {
    const result = z.array(z.string()).max(2).safeParse(Array.from({ length: 1000 }, () => null));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.code).toBe("too_big");
    }
  });
});
