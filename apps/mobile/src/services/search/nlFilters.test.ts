import { describe, expect, it } from "vitest";
import { mustProfile, stubGenerate } from "../ai/ops/testSupport";
import {
  extractNlFilters,
  isNlPatchEmpty,
  resolveNlCategory,
  resolveNlDateRange,
  resolveNlStatus,
  toValidatedPatch,
} from "./nlFilters";

const PROFILE = "qwen3-0.6b-dynamic-int4";
const NOW = new Date("2026-09-25T12:00:00.000Z");

describe("resolveNlCategory", () => {
  it("accepts exact canonical categories case-insensitively", () => {
    expect(resolveNlCategory("Bags & Wallets")).toBe("Bags & Wallets");
    expect(resolveNlCategory("  keys ")).toBe("Keys");
  });

  it("resolves an unambiguous synonym to its canonical category", () => {
    expect(resolveNlCategory("wallet")).toBe("Bags & Wallets");
  });

  it("leaves ambiguous or unknown categories empty instead of guessing", () => {
    expect(resolveNlCategory("phone")).toBeUndefined();
    expect(resolveNlCategory("flying carpet")).toBeUndefined();
    expect(resolveNlCategory("")).toBeUndefined();
    expect(resolveNlCategory(undefined)).toBeUndefined();
  });
});

describe("resolveNlStatus", () => {
  it("accepts known post statuses case-insensitively", () => {
    expect(resolveNlStatus("open")).toBe("OPEN");
    expect(resolveNlStatus(" Recovered ")).toBe("RECOVERED");
  });

  it("leaves non-status words (like lost/found types) empty", () => {
    expect(resolveNlStatus("lost")).toBeUndefined();
    expect(resolveNlStatus("found")).toBeUndefined();
    expect(resolveNlStatus("urgent")).toBeUndefined();
    expect(resolveNlStatus(undefined)).toBeUndefined();
  });
});

describe("resolveNlDateRange", () => {
  it("maps last week to a bounded 7-day range ending today", () => {
    expect(resolveNlDateRange("last week", NOW)).toEqual({
      dateFrom: "2026-09-18",
      dateTo: "2026-09-25",
    });
  });

  it("maps today and yesterday to exact-day ranges", () => {
    expect(resolveNlDateRange("today", NOW)).toEqual({ dateFrom: "2026-09-25", dateTo: "2026-09-25" });
    expect(resolveNlDateRange("yesterday", NOW)).toEqual({
      dateFrom: "2026-09-24",
      dateTo: "2026-09-24",
    });
  });

  it("maps last month to a bounded 30-day range", () => {
    expect(resolveNlDateRange("last month", NOW)).toEqual({
      dateFrom: "2026-08-26",
      dateTo: "2026-09-25",
    });
  });

  it("leaves vague or coordinate-looking ranges empty", () => {
    expect(resolveNlDateRange("sometime", NOW)).toEqual({});
    expect(resolveNlDateRange("near 12.3456, 65.4321", NOW)).toEqual({});
    expect(resolveNlDateRange(undefined, NOW)).toEqual({});
  });
});

describe("toValidatedPatch", () => {
  it("builds a validated patch while dropping invalid values", () => {
    const patch = toValidatedPatch(
      { query: "black wallet", category: "wallet", status: "lost", dateRangeText: "last week" },
      NOW,
    );
    expect(patch.query).toBe("black wallet");
    expect(patch.category).toBe("Bags & Wallets");
    // "lost" is a post type, not a status: stays empty, never coerced.
    expect(patch.status).toBeUndefined();
    expect(patch.dateFrom).toBe("2026-09-18");
    expect(patch.dateTo).toBe("2026-09-25");
  });

  it("drops coordinate-bearing queries instead of passing them through", () => {
    const patch = toValidatedPatch({ query: "umbrella at 12.3456, 65.4321" }, NOW);
    expect(patch.query).toBeUndefined();
    expect(isNlPatchEmpty(patch)).toBe(true);
  });
});

describe("extractNlFilters (op consumer)", () => {
  it("maps 'black wallet lost last week' to validated editable patches", async () => {
    const patch = await extractNlFilters(
      stubGenerate(
        JSON.stringify({
          query: "black wallet",
          category: "wallet",
          status: "open",
          dateRangeText: "last week",
        }),
      ),
      "black wallet lost last week",
      mustProfile(PROFILE),
      { now: NOW },
    );
    expect(patch).toEqual({
      query: "black wallet",
      category: "Bags & Wallets",
      status: "OPEN",
      dateFrom: "2026-09-18",
      dateTo: "2026-09-25",
    });
  });

  it("fails closed to an empty patch when the op fails", async () => {
    const patch = await extractNlFilters(stubGenerate("not json at all {{{"), "xyz", mustProfile(PROFILE));
    expect(isNlPatchEmpty(patch)).toBe(true);
  });

  it("fails closed to an empty patch on empty input without calling generate", async () => {
    const generate = stubGenerate('{"query":"keys"}');
    const patch = await extractNlFilters(generate, "   ", mustProfile(PROFILE));
    expect(isNlPatchEmpty(patch)).toBe(true);
    expect(generate.calls).toBe(0);
  });

  it("keeps uncertain extractions empty instead of guessing", async () => {
    const patch = await extractNlFilters(
      stubGenerate(
        JSON.stringify({ category: "flying carpet", status: "eventually", dateRangeText: "sometime" }),
      ),
      "something vague",
      mustProfile(PROFILE),
      { now: NOW },
    );
    expect(isNlPatchEmpty(patch)).toBe(true);
  });
});
