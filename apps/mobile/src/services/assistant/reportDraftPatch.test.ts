import { describe, expect, it } from "vitest";
import {
  buildReportDraftPatch,
  isEmptyPatch,
  mergeReportDraftPatch,
} from "./reportDraftPatch";

describe("buildReportDraftPatch", () => {
  it("maps report intents to the draft type", () => {
    expect(buildReportDraftPatch({}, "REPORT_LOST").type).toBe("LOST");
    expect(buildReportDraftPatch({}, "REPORT_FOUND").type).toBe("FOUND");
  });

  it("leaves the type unset for non-report intents", () => {
    expect(buildReportDraftPatch({}, "SEARCH").type).toBeUndefined();
    expect(buildReportDraftPatch({}, "APP_QUESTION").type).toBeUndefined();
    expect(buildReportDraftPatch({}, "OPEN_QUESTION").type).toBeUndefined();
    expect(buildReportDraftPatch({}, "UNKNOWN").type).toBeUndefined();
  });

  it("carries confirmed text fields verbatim", () => {
    const patch = buildReportDraftPatch(
      { title: "Keys", description: "Brass keys", locationNote: "Central library" },
      "REPORT_LOST",
    );
    expect(patch.title).toBe("Keys");
    expect(patch.description).toBe("Brass keys");
    expect(patch.locationNote).toBe("Central library");
  });

  it("keeps only known categories", () => {
    expect(buildReportDraftPatch({ category: "Keys" }, "REPORT_LOST").category).toBe(
      "Keys",
    );
    expect(
      buildReportDraftPatch({ category: "Spaceship" }, "REPORT_LOST").category,
    ).toBeUndefined();
  });

  it("keeps only calendar dates", () => {
    expect(
      buildReportDraftPatch({ dateText: "2026-09-01" }, "REPORT_FOUND").eventDate,
    ).toBe("2026-09-01");
    expect(
      buildReportDraftPatch({ dateText: "someday" }, "REPORT_FOUND").eventDate,
    ).toBeUndefined();
    expect(
      buildReportDraftPatch({ dateText: "2026-02-30" }, "REPORT_FOUND").eventDate,
    ).toBeUndefined();
  });
});

describe("mergeReportDraftPatch", () => {
  it("merges field by field with the update winning", () => {
    const merged = mergeReportDraftPatch(
      buildReportDraftPatch({ title: "Keys", category: "Keys" }, "REPORT_LOST"),
      buildReportDraftPatch({ title: "Brass keys" }, "REPORT_LOST"),
    );
    expect(merged.title).toBe("Brass keys");
    expect(merged.category).toBe("Keys");
    expect(merged.type).toBe("LOST");
  });

  it("never drops the base on an empty update", () => {
    const base = buildReportDraftPatch({ title: "Keys" }, "REPORT_LOST");
    expect(mergeReportDraftPatch(base, {})).toEqual(base);
  });
});

describe("isEmptyPatch", () => {
  it("detects empty and non-empty patches", () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch(buildReportDraftPatch({}, "SEARCH"))).toBe(true);
    expect(isEmptyPatch(buildReportDraftPatch({ title: "Keys" }, "SEARCH"))).toBe(false);
  });
});
