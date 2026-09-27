import { describe, expect, it } from "vitest";
import { startFlow } from "./guidedAssistantController";
import { assistantCategoryCandidates, isAssistantCategoryAmbiguous, resolveAssistantCategory, resolveReportTurn } from "./reportTurnResolver";

describe("resolveAssistantCategory", () => {
  it("maps phone to Phones & Tablets", () => {
    expect(resolveAssistantCategory("I lost my phone")).toBe("Phones & Tablets");
  });
  it("maps laptop to Computers & Accessories", () => {
    expect(resolveAssistantCategory("I lost my laptop")).toBe("Computers & Accessories");
  });
  it("maps camera to Cameras & Photography", () => {
    expect(resolveAssistantCategory("I found a camera")).toBe("Cameras & Photography");
  });
  it("maps headphones to Audio & Wearables", () => {
    expect(resolveAssistantCategory("I lost my headphones")).toBe("Audio & Wearables");
  });
  it("maps shoes to Footwear", () => {
    expect(resolveAssistantCategory("I lost my shoes")).toBe("Footwear");
  });
  it("keeps charger on broad Electronics", () => {
    expect(resolveAssistantCategory("I lost my charger")).toBe("Electronics");
  });
  it("maps keychain to Keys", () => {
    expect(resolveAssistantCategory("I lost my keychain")).toBe("Keys");
  });
  it("returns undefined for unknown bj", () => {
    expect(resolveAssistantCategory("bj")).toBeUndefined();
  });
  it("leaves an unqualified notebook ambiguous instead of guessing Computers", () => {
    expect(resolveAssistantCategory("I lost my notebook")).toBeUndefined();
    expect(isAssistantCategoryAmbiguous("I lost my notebook")).toBe(true);
    expect(assistantCategoryCandidates("I lost my notebook")).toEqual([
      "Computers & Accessories",
      "Books & Stationery",
    ]);
  });
  it("leaves phone charger ambiguous instead of committing Phones", () => {
    expect(resolveAssistantCategory("I lost my phone charger")).toBeUndefined();
    expect(isAssistantCategoryAmbiguous("I lost my phone charger")).toBe(true);
  });
  it("leaves camera bag ambiguous instead of committing Cameras", () => {
    expect(resolveAssistantCategory("I found a camera bag")).toBeUndefined();
    expect(isAssistantCategoryAmbiguous("I found a camera bag")).toBe(true);
  });
  it("keeps an unambiguous match confident", () => {
    expect(isAssistantCategoryAmbiguous("I lost my phone")).toBe(false);
    expect(assistantCategoryCandidates("I lost my phone")).toEqual(["Phones & Tablets"]);
  });
});

describe("resolveReportTurn", () => {
  it("resolves a slot value with multiple fields from one sentence", () => {
    const snapshot = startFlow("lost");
    const resolved = resolveReportTurn(
      snapshot,
      "I lost my black phone near Central library on 2026-09-01",
    );
    expect(resolved.kind).toBe("SLOT_VALUE");
    expect(resolved.fields?.category).toBe("Phones & Tablets");
    expect(resolved.fields?.dateText).toBe("2026-09-01");
    expect(resolved.fields?.locationNote).toBe("Central library");
  });
  it("extracts a location introduced by a capitalized preposition", () => {
    const resolved = resolveReportTurn(
      startFlow("lost"),
      "I lost my phone. Near Central Park on 2026-09-01",
    );
    expect(resolved.fields?.locationNote).toBe("Central Park");
  });
  it("resolves a greeting without consuming the pending flow", () => {
    const snapshot = startFlow("lost");
    const resolved = resolveReportTurn(snapshot, "hello");
    expect(resolved.kind).toBe("GREETING");
  });
  it("resolves an app question as a side question", () => {
    const snapshot = startFlow("lost");
    const resolved = resolveReportTurn(snapshot, "how do I add a photo?");
    expect(resolved.kind).toBe("SIDE_QUESTION");
  });
  it("keeps a question-shaped location answer in the pending report flow", () => {
    const snapshot = {
      ...startFlow("lost"),
      state: "awaitingLocation" as const,
      patch: { title: "Black phone" },
      missingFields: ["location" as const],
    };
    const resolved = resolveReportTurn(snapshot, "North gate bench?");
    expect(resolved.kind).toBe("SLOT_VALUE");
    expect(resolved.fields?.locationNote).toBe("North gate bench?");
  });
  it("resolves an explicit search pivot as an intent switch", () => {
    const snapshot = startFlow("lost");
    const resolved = resolveReportTurn(snapshot, "actually I want to search for black umbrella");
    expect(resolved.kind).toBe("INTENT_SWITCH");
    expect(resolved.intent).toBe("SEARCH");
  });
  it("resolves unknown bj as unrecognized with the unmatched value", () => {
    const snapshot = startFlow("lost");
    const resolved = resolveReportTurn(snapshot, "bj");
    expect(resolved.kind).toBe("UNRECOGNIZED");
    expect(resolved.unmatchedCategory).toBe("bj");
  });
});
