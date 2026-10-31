// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_PREFERENCES_DEFAULTS, aiPreferencesKey, legacyAssistantModeToPreference,
  loadAiPreferences, loadSeededAiPreferences, saveAiPreferences, updateAiPreferences,
} from "./aiPreferences";

afterEach(() => localStorage.clear());

describe("legacy preference compatibility, not a local routing policy", () => {
  it("preserves an old account's privacy pin during an unrelated model edit", () => {
    localStorage.setItem("findback.ai.assistantMode.v1.acct-legacy", "offline-only");
    updateAiPreferences("acct-legacy", { preferredAssistantModel: "openrouter/free" });
    expect(loadAiPreferences("acct-legacy")).toMatchObject({
      assistantMode: "on-device-only", preferredAssistantModel: "openrouter/free",
    });
  });

  it("defaults to USE matching and no legacy model selection", () => {
    expect(loadAiPreferences("new")).toEqual(AI_PREFERENCES_DEFAULTS);
    expect(loadAiPreferences("new").matchesEngine).toBe("use");
    expect(loadAiPreferences("new").preferredAssistantModel).toBeNull();
  });

  it("isolates every persisted choice by account", () => {
    saveAiPreferences("a", { ...AI_PREFERENCES_DEFAULTS, matchesEngine: "needle", assistantMode: "cloud-only", preferredAssistantModel: "groq/paid-model" });
    expect(loadAiPreferences("b")).toEqual(AI_PREFERENCES_DEFAULTS);
    expect(loadAiPreferences("a")).toMatchObject({ matchesEngine: "needle", assistantMode: "cloud-only", preferredAssistantModel: "groq/paid-model" });
    expect(aiPreferencesKey("a")).not.toBe(aiPreferencesKey("b"));
  });

  it("persists and clears a model selection without changing the sibling account", () => {
    updateAiPreferences("a", { preferredAssistantModel: "openrouter/free" });
    expect(loadAiPreferences("a").preferredAssistantModel).toBe("openrouter/free");
    expect(loadAiPreferences("b").preferredAssistantModel).toBeNull();
    updateAiPreferences("a", { preferredAssistantModel: null });
    expect(loadAiPreferences("a").preferredAssistantModel).toBeNull();
  });

  it.each(["{not-json", JSON.stringify({ assistantMode: "turbo", preferredAssistantModel: 42, photoEngine: "sometimes", matchesEngine: "needle-pro" })])("sanitizes corrupt stored values: %s", (value) => {
    localStorage.setItem(aiPreferencesKey("bad"), value);
    expect(loadAiPreferences("bad")).toEqual(AI_PREFERENCES_DEFAULTS);
  });

  it("decodes old mode strings only for one-time compatibility storage", () => {
    for (const [old, stored] of [["cloud-only", "cloud-only"], ["offline-only", "on-device-only"], ["offline-first", "on-device-only"], ["auto", "automatic"], ["turbo", "automatic"]]) {
      expect(legacyAssistantModeToPreference(old)).toBe(stored);
    }
  });

  it("adopts the legacy key once and never lets it override the new account store", () => {
    localStorage.setItem("findback.ai.assistantMode.v1.migrate", "cloud-only");
    expect(loadSeededAiPreferences("migrate").assistantMode).toBe("cloud-only");
    localStorage.setItem("findback.ai.assistantMode.v1.migrate", "offline-only");
    expect(loadSeededAiPreferences("migrate").assistantMode).toBe("cloud-only");
    expect(loadSeededAiPreferences("fresh")).toEqual(AI_PREFERENCES_DEFAULTS);
  });
});
