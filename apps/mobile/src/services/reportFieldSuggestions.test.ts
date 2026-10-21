// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stubGenerate, mustProfile } from "./ai/ops/testSupport";
import {
  buildReportFieldSuggestions,
  REPORT_FIELD_SOURCE,
  suggestReportFields,
} from "./reportFieldSuggestions";
import { DROPPED_CATEGORY_NOTE } from "./reportSuggestionNotes";

const PROFILE = mustProfile("qwen3-0.6b-dynamic-int4");
const MESSAGE = "I lost my black umbrella yesterday near the central market.";

describe("buildReportFieldSuggestions (pure map)", () => {
  it("maps title/description/date/released-category to reviewable patches with source", () => {
    const built = buildReportFieldSuggestions({
      title: "Black umbrella",
      description: "Lost yesterday",
      category: "Umbrellas & Bottles",
      dateText: "yesterday",
      locationNote: "central market",
    });
    expect(built.droppedCategory).toBe(false);
    expect(built.suggestions).toEqual([
      { field: "title", suggestedValue: "Black umbrella", source: REPORT_FIELD_SOURCE },
      { field: "description", suggestedValue: "Lost yesterday", source: REPORT_FIELD_SOURCE },
      { field: "date", suggestedValue: "yesterday", source: REPORT_FIELD_SOURCE },
      { field: "category", suggestedValue: "Umbrellas & Bottles", source: REPORT_FIELD_SOURCE },
    ]);
  });

  it("downgrades an unreleased category but keeps title/description/date reviewable", () => {
    const built = buildReportFieldSuggestions({
      title: "Black umbrella",
      description: "Lost yesterday",
      category: "Spaceship Parts",
    });
    expect(built.droppedCategory).toBe(true);
    expect(built.suggestions.map((s) => s.field)).toEqual(["title", "description"]);
    expect(DROPPED_CATEGORY_NOTE).toMatch(/left out/);
  });

  it("emits no patches for empty input (Keep sends nothing, nothing to Apply)", () => {
    const built = buildReportFieldSuggestions({});
    expect(built.suggestions).toEqual([]);
    expect(built.droppedCategory).toBe(false);
  });

  it("skips blank strings and trims values", () => {
    const built = buildReportFieldSuggestions({ title: "   ", description: "  Kept  " });
    expect(built.suggestions).toEqual([
      { field: "description", suggestedValue: "Kept", source: REPORT_FIELD_SOURCE },
    ]);
  });
});

describe("suggestReportFields (extract-report-fields consumer, fakes only)", () => {
  it("returns reviewable patches from a fake extraction", async () => {
    const generate = stubGenerate(
      '{"title":"Black umbrella","description":"Lost yesterday","category":"Umbrellas & Bottles",' +
        '"dateText":"yesterday","locationNote":"central market"}',
    );
    const result = await suggestReportFields(generate, MESSAGE, PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.suggestions.map((s) => s.field)).toEqual(["title", "description", "date", "category"]);
      expect(result.value.suggestions.every((s) => s.source === "extract-report-fields")).toBe(true);
      // The values the extraction produced, not merely the fields it named: a
      // copy of the reviewed list that substitutes or fabricates a value renders
      // and can be applied, so the reviewable patch is only reviewable if the
      // value it carries is the one that was extracted (CF-070 gate review
      // MAJOR-1).
      expect(result.value.suggestions.map((s) => s.suggestedValue)).toEqual([
        "Black umbrella",
        "Lost yesterday",
        "yesterday",
        "Umbrellas & Bottles",
      ]);
      expect(result.value.droppedCategory).toBe(false);
      expect(result.value.action).toEqual({ action: "NONE" });
    }
    expect(generate.calls).toBe(1);
  });

  it("downgrades an unreleased category to dropped, keeping other patches", async () => {
    const generate = stubGenerate('{"title":"Keys","category":"Spaceship Parts"}');
    const result = await suggestReportFields(generate, "Lost keys.", PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.suggestions.map((s) => s.field)).toEqual(["title"]);
      expect(result.value.suggestions.map((s) => s.suggestedValue)).toEqual(["Keys"]);
      expect(result.value.droppedCategory).toBe(true);
    }
  });

  it("fails closed on malformed model output (no patches, no apply)", async () => {
    const generate = stubGenerate("{objectName: black umbrella, colors: [}");
    const result = await suggestReportFields(generate, "Lost umbrella.", PROFILE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("INVALID_OUTPUT");
  });

  it("never calls generate when already aborted (ABORT_BEFORE_START)", async () => {
    const generate = stubGenerate('{"title":"Keys"}');
    const controller = new AbortController();
    controller.abort();
    const result = await suggestReportFields(generate, "Lost keys.", PROFILE, {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("aborts mid-generation cleanly with no fallback side effects", async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const generate = Object.assign(async () => pending, { calls: 0 });
    const controller = new AbortController();
    const task = suggestReportFields(generate, "Lost keys.", PROFILE, { signal: controller.signal });
    controller.abort();
    // The late model output must never surface: cancellation wins the race.
    release('{"title":"Late keys"}');
    const result = await task;
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_MID_GENERATION" } });
  });

  it("does not mislabel a transport failure as cancellation", async () => {
    const failing = Object.assign(
      async (): Promise<string> => {
        throw new Error("transport exploded");
      },
      { calls: 0 },
    );
    // The documented contract is `AiResult`, so an engine failure comes back as
    // a result the screen renders ("Couldn't draft suggestions…"), never as a
    // rejection: a rejection here is silently unhandled unless every caller
    // remembers a try/catch (CF-040 F7).
    const result = await suggestReportFields(failing, MESSAGE, PROFILE);
    expect(result).toEqual({
      ok: false,
      error: { errorClass: "RUNTIME_ERROR", diagnostic: "FIELDS_GENERATION_FAILED" },
    });
  });
});
