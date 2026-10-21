import { describe, expect, it } from "vitest";
import { mustProfile, stubGenerate } from "../ai/ops/testSupport";
import {
  extractNlFilters,
  isNlPatchEmpty,
  resolveNlCategory,
  resolveNlDateRange,
  resolveNlPlace,
  resolveNlPostType,
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

describe("resolveNlPostType", () => {
  it("resolves the words that mean the LOST/FOUND type", () => {
    expect(resolveNlPostType("lost")).toBe("LOST");
    expect(resolveNlPostType("Lost")).toBe("LOST");
    expect(resolveNlPostType(" missing ")).toBe("LOST");
    expect(resolveNlPostType("stolen")).toBe("LOST");
    expect(resolveNlPostType("FOUND")).toBe("FOUND");
  });

  it("leaves anything that is not a type empty instead of guessing", () => {
    expect(resolveNlPostType("open")).toBeUndefined();
    expect(resolveNlPostType("urgent")).toBeUndefined();
    expect(resolveNlPostType("")).toBeUndefined();
    expect(resolveNlPostType(undefined)).toBeUndefined();
  });
});

describe("resolveNlPlace", () => {
  it("keeps a place name", () => {
    expect(resolveNlPlace("Dhaka")).toBe("Dhaka");
    expect(resolveNlPlace("  Gulshan  ")).toBe("Gulshan");
  });

  it("refuses a coordinate, a number and a time phrase", () => {
    // A coordinate is never a place: the app has no geo filter.
    expect(resolveNlPlace("23.8103, 90.4125")).toBeUndefined();
    expect(resolveNlPlace("221")).toBeUndefined();
    expect(resolveNlPlace("last week")).toBeUndefined();
    expect(resolveNlPlace("")).toBeUndefined();
    expect(resolveNlPlace(undefined)).toBeUndefined();
  });
});

describe("resolveNlDateRange", () => {  it("maps last week to a bounded 7-day range ending today", () => {
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

  it("reads the LOST/FOUND type from its own slot", () => {
    const patch = toValidatedPatch({ query: "black wallet", postType: "LOST" }, NOW);
    expect(patch.postType).toBe("LOST");
    // The type is not a status: the status filter stays empty.
    expect(patch.status).toBeUndefined();
  });

  it("reads a type that arrives in the legacy status slot", () => {
    // The old schema said the type went in `status`, where the status enum
    // has no "lost" — so a type there was a filter the reader could never
    // set. It is read as the type.
    const patch = toValidatedPatch({ query: "keys", status: "lost" }, NOW);
    expect(patch.postType).toBe("LOST");
    expect(patch.status).toBeUndefined();
  });

  it("keeps a place a name and never a coordinate", () => {
    const named = toValidatedPatch({ query: "umbrella", place: "Gulshan" }, NOW);
    expect(named.place).toBe("Gulshan");
    const coordinates = toValidatedPatch({ query: "umbrella", place: "23.8103, 90.4125" }, NOW);
    expect(coordinates.place).toBeUndefined();
  });

  it("carries a refused place out of the patch instead of dropping it in silence", () => {
    // The reader must be able to be told that a place was refused, so the
    // refusal travels with the patch — while the place itself stays out of
    // it, so it can never become a filter.
    const refused = toValidatedPatch({ query: "umbrella", place: "42" }, NOW);
    expect(refused.place).toBeUndefined();
    expect(refused.placeRefused).toBe(true);
    // A refusal is not a filter: a patch that carries nothing but a refusal
    // is still empty of filters.
    expect(isNlPatchEmpty(toValidatedPatch({ place: "42" }, NOW))).toBe(true);

    const timePhrase = toValidatedPatch({ query: "umbrella", place: "last week" }, NOW);
    expect(timePhrase.place).toBeUndefined();
    expect(timePhrase.placeRefused).toBe(true);

    // Nothing offered, nothing refused.
    const nothing = toValidatedPatch({ query: "umbrella" }, NOW);
    expect(nothing.placeRefused).toBeUndefined();
  });

  it("never guesses a type or a place it was not given", () => {
    const patch = toValidatedPatch({ query: "umbrella" }, NOW);
    expect(patch.postType).toBeUndefined();
    expect(patch.place).toBeUndefined();
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

  it("maps a typed phrase to the type and the place the reader named", async () => {
    const patch = await extractNlFilters(
      stubGenerate(
        JSON.stringify({ query: "black wallet", postType: "LOST", place: "Gulshan" }),
      ),
      "black wallet lost in Gulshan",
      mustProfile(PROFILE),
      { now: NOW },
    );
    expect(patch).toEqual({
      query: "black wallet",
      postType: "LOST",
      place: "Gulshan",
    });
  });

  it("fails closed when the place is really a coordinate", async () => {
    // The op contract refuses a coordinate in ANY slot, so the whole
    // extraction is refused rather than half-applied — and the ordinary
    // search runs on the reader's words.
    const patch = await extractNlFilters(
      stubGenerate(
        JSON.stringify({ query: "umbrella", postType: "FOUND", place: "23.8103, 90.4125" }),
      ),
      "umbrella found at 23.8103, 90.4125",
      mustProfile(PROFILE),
      { now: NOW },
    );
    expect(isNlPatchEmpty(patch)).toBe(true);
  });

  it("carries a refused place out of the real path", async () => {
    // A bare number passes the op contract (it is not a coordinate) and is
    // refused by the place resolver — and the refusal travels with the
    // patch, so the screen can tell the reader.
    const patch = await extractNlFilters(
      stubGenerate(JSON.stringify({ query: "umbrella", place: "42" })),
      "umbrella near 42",
      mustProfile(PROFILE),
      { now: NOW },
    );
    expect(patch.place).toBeUndefined();
    expect(patch.placeRefused).toBe(true);
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
