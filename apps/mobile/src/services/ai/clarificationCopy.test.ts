import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLARIFICATION_QUESTIONS,
  defaultClarificationQuestion,
  makeAskUserPrompt,
} from "./clarificationCopy";
import {
  ASK_USER_OPTIONS_MAX,
  ASK_USER_OPTION_MAX,
  ASK_USER_QUESTION_MAX,
  CLARIFICATION_FIELDS,
  isAskUserPrompt,
} from "./types";
import { validateIntentPayload } from "./normalize";
import { extractReportFields } from "./ops/extractReportFields";
import { extractSearchFilters } from "./ops/extractSearchFilters";
import { mustProfile, stubGenerate } from "./ops/testSupport";

const COORD_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;

describe("clarification copy defaults per field", () => {
  it("covers every clarification field with a bounded question", () => {
    expect(Object.keys(DEFAULT_CLARIFICATION_QUESTIONS).sort()).toEqual([...CLARIFICATION_FIELDS].sort());
    for (const field of CLARIFICATION_FIELDS) {
      const question = defaultClarificationQuestion(field);
      expect(question.trim().length).toBeGreaterThan(0);
      expect(question.length).toBeLessThanOrEqual(ASK_USER_QUESTION_MAX);
      expect(question).not.toMatch(COORD_PATTERN);
      expect(isAskUserPrompt({ question, field })).toBe(true);
    }
  });

  it("keeps defaults distinct per field (no single global sentence)", () => {
    const questions = CLARIFICATION_FIELDS.map((field) => defaultClarificationQuestion(field));
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("flows defaults through the layer without options", () => {
    for (const field of CLARIFICATION_FIELDS) {
      expect(makeAskUserPrompt({ field })).toEqual({
        question: DEFAULT_CLARIFICATION_QUESTIONS[field],
        field,
      });
    }
  });
});

describe("clarification copy contextual override", () => {
  it("lets an evidence-backed override win over the default", () => {
    const prompt = makeAskUserPrompt({
      field: "location",
      context: "user said Central Park without specifying which one",
      options: ["Central Park North", "Central Park South"],
      questionOverride: "Which Central Park do you mean?",
    });
    expect(prompt.field).toBe("location");
    expect(prompt.question).toBe("Which Central Park do you mean?");
    expect(prompt.options).toEqual(["Central Park North", "Central Park South"]);
    expect(isAskUserPrompt(prompt)).toBe(true);
  });

  it("falls back to the default on empty or overlong overrides", () => {
    expect(makeAskUserPrompt({ field: "query", questionOverride: "   " }).question).toBe(
      DEFAULT_CLARIFICATION_QUESTIONS["query"],
    );
    expect(makeAskUserPrompt({ field: "query", questionOverride: "x".repeat(281) }).question).toBe(
      DEFAULT_CLARIFICATION_QUESTIONS["query"],
    );
  });

  it("passes valid options through and sanitizes invalid ones", () => {
    const valid = makeAskUserPrompt({ field: "photo", options: ["Front view", "Back view"] });
    expect(valid.options).toEqual(["Front view", "Back view"]);
    const tooMany = makeAskUserPrompt({
      field: "other",
      options: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(tooMany.options).toHaveLength(ASK_USER_OPTIONS_MAX);
    const cleaned = makeAskUserPrompt({
      field: "category",
      options: ["", "  ", "keys", "x".repeat(ASK_USER_OPTION_MAX + 1)],
    });
    expect(cleaned.options).toEqual(["keys"]);
    const noneLeft = makeAskUserPrompt({ field: "date", options: ["", "   "] });
    expect(noneLeft.options).toBeUndefined();
  });
});

describe("ops ASK_USER paths flow through the copy layer", () => {
  it("resolves UNKNOWN intent to the central query default", () => {
    const result = validateIntentPayload({ intent: "UNKNOWN" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.prompt?.question).toBe(DEFAULT_CLARIFICATION_QUESTIONS["query"]);
    }
  });

  it("resolves missing report location to the central location default", async () => {
    const result = await extractReportFields(
      stubGenerate('{"title":"Wallet","description":"Brown leather wallet"}'),
      "I lost my wallet.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.prompt?.field).toBe("location");
      expect(result.value.action.prompt?.question).toBe(DEFAULT_CLARIFICATION_QUESTIONS["location"]);
    }
  });

  it("resolves empty search filters to the central query default", async () => {
    const result = await extractSearchFilters(
      stubGenerate("{}"),
      "Search for stuff.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.prompt?.field).toBe("query");
      expect(result.value.action.prompt?.question).toBe(DEFAULT_CLARIFICATION_QUESTIONS["query"]);
    }
  });
});
