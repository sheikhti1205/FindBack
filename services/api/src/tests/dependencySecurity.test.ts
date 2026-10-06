import { describe, expect, it } from "vitest";
import { mergeDeep } from "@graphql-tools/utils";

/**
 * FBA-038 regression guard (dependency security).
 *
 * graphql-yoga previously resolved `@graphql-tools/utils@11.2.2`, whose
 * `mergeDeep` was vulnerable to prototype pollution
 * (CVE-2026-104852 / GHSA-7mx3-vvmw-hjmv). The root npm override pins the
 * fixed `12.0.1`; this proves the *installed* copy ignores `__proto__` and
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
