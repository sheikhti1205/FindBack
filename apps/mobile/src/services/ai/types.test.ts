import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  CLARIFICATION_FIELDS,
  INTENTS,
  isAction,
  isAskUserPrompt,
  isAssistantAction,
  isIntent,
  makeAiError,
  PHOTO_ANALYSIS_KEYS,
} from "./types";

describe("AI common contract vocabularies", () => {
  it("freezes the six-intent and nine-action allowlists", () => {
    expect([...INTENTS]).toEqual([
      "REPORT_LOST",
      "REPORT_FOUND",
      "SEARCH",
      "APP_QUESTION",
      "OPEN_QUESTION",
      "UNKNOWN",
    ]);
    expect([...ACTIONS]).toEqual([
      "NONE",
      "ASK_USER",
      "OPEN_REPORT",
      "OPEN_SEARCH",
      "OPEN_MAP",
      "PICK_PHOTO",
      "TAKE_PHOTO",
      "OPEN_MODEL_LIBRARY",
      "APPLY_REPORT_DRAFT",
    ]);
  });

  it("guards intents and actions", () => {
    expect(isIntent("SEARCH")).toBe(true);
    expect(isIntent("TELEPORT")).toBe(false);
    expect(isIntent(undefined)).toBe(false);
    expect(isAction("ASK_USER")).toBe(true);
    expect(isAction("delete_someone_elses_post")).toBe(false);
  });

  it("defines the ASK_USER field shape with bounds", () => {
    expect(
      isAskUserPrompt({ question: "Where was it?", field: "location", options: ["Market", "Park"] }),
    ).toBe(true);
    expect(isAskUserPrompt({ question: "   ", field: "location" })).toBe(false);
    expect(isAskUserPrompt({ question: "Where?", field: "gps" })).toBe(false);
    expect(isAskUserPrompt({ question: "Where?" })).toBe(false);
    for (const field of CLARIFICATION_FIELDS) {
      expect(isAskUserPrompt({ question: "Q?", field })).toBe(true);
    }
    expect(
      isAskUserPrompt({ question: "Q?", field: "query", options: ["a", "b", "c", "d", "e", "f", "g"] }),
    ).toBe(false);
    expect(
      isAskUserPrompt({ question: "Q?", field: "query", options: ["", "ok"] }),
    ).toBe(false);
  });

  it("requires a prompt exactly for ASK_USER actions", () => {
    expect(
      isAssistantAction({ action: "ASK_USER", prompt: { question: "Which place?", field: "location" } }),
    ).toBe(true);
    expect(isAssistantAction({ action: "ASK_USER" })).toBe(false);
    expect(isAssistantAction({ action: "NONE" })).toBe(true);
    expect(
      isAssistantAction({ action: "NONE", prompt: { question: "Q?", field: "query" } }),
    ).toBe(false);
    expect(isAssistantAction({ action: "NOPE" })).toBe(false);
  });

  it("builds errors with frozen classes and diagnostics", () => {
    expect(makeAiError("INVALID_OUTPUT", "R1_NO_JSON_OBJECT")).toEqual({
      errorClass: "INVALID_OUTPUT",
      diagnostic: "R1_NO_JSON_OBJECT",
    });
    expect(makeAiError("UNSUPPORTED_REQUEST", "R4_REFUSAL_POLICY", "REFUSAL_PII")).toEqual({
      errorClass: "UNSUPPORTED_REQUEST",
      diagnostic: "R4_REFUSAL_POLICY",
      reason: "REFUSAL_PII",
    });
  });

  it("fixes the nine-field photo schema", () => {
    expect([...PHOTO_ANALYSIS_KEYS]).toEqual([
      "objectName",
      "suggestedCategory",
      "colors",
      "visibleBrand",
      "visibleText",
      "identifyingFeatures",
      "suggestedTitle",
      "suggestedDescription",
      "uncertainFields",
    ]);
  });
});
