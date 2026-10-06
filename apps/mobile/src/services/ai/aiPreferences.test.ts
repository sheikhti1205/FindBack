// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_PREFERENCES_DEFAULTS,
  aiPreferencesKey,
  createAssistantModelBinding,
  EFFECTIVE_PHOTO_ENGINE_KEY,
  effectivePhotoEngine,
  isNeedleSelectable,
  legacyAssistantModeToPreference,
  loadAiPreferences,
  loadEffectiveAssistantMode,
  loadSeededAiPreferences,
  preferenceToAssistantMode,
  publishEffectivePhotoEngine,
  resolvePreferredModelId,
  saveAiPreferences,
  updateAiPreferences,
} from "./aiPreferences";
import { DEFAULT_MODEL_ID } from "./modelPolicy";

afterEach(() => {
  window.localStorage.clear();
});

describe("aiPreferences store (Lane A)", () => {
  it("a first model edit preserves the legacy on-device privacy pin", () => {
    localStorage.setItem("findback.ai.assistantMode.v1.acct-legacy", "offline-only");
    updateAiPreferences("acct-legacy", { preferredAssistantModel: "openrouter/free" });
    expect(loadEffectiveAssistantMode("acct-legacy")).toBe("offline-only");
    expect(loadAiPreferences("acct-legacy").preferredAssistantModel).toBe("openrouter/free");
  });
  it("defaults to automatic engines with no preferred model (Automatic → free-only default)", () => {
    const prefs = loadAiPreferences("acct-new");
    expect(prefs).toEqual(AI_PREFERENCES_DEFAULTS);
    expect(prefs.assistantMode).toBe("automatic");
    expect(prefs.preferredAssistantModel).toBeNull();
    expect(prefs.photoEngine).toBe("automatic");
    expect(prefs.matchesEngine).toBe("use");
    expect(resolvePreferredModelId(prefs)).toBe(DEFAULT_MODEL_ID);
  });

  it("isolates preferences per account and never leaks across accounts", () => {
    saveAiPreferences("acct-a", {
      ...AI_PREFERENCES_DEFAULTS,
      assistantMode: "cloud-only",
      preferredAssistantModel: "groq/paid-model",
    });
    const other = loadAiPreferences("acct-b");
    expect(other.assistantMode).toBe("automatic");
    expect(other.preferredAssistantModel).toBeNull();
    const same = loadAiPreferences("acct-a");
    expect(same.assistantMode).toBe("cloud-only");
    expect(same.preferredAssistantModel).toBe("groq/paid-model");
    expect(aiPreferencesKey("acct-a")).not.toBe(aiPreferencesKey("acct-b"));
  });

  it("persists a permitted model selection for exactly that account", () => {
    updateAiPreferences("acct-a", { preferredAssistantModel: "openrouter/free" });
    expect(loadAiPreferences("acct-a").preferredAssistantModel).toBe("openrouter/free");
    expect(resolvePreferredModelId(loadAiPreferences("acct-a"))).toBe("openrouter/free");
    // The sibling account still falls back to the safe free default.
    expect(resolvePreferredModelId(loadAiPreferences("acct-b"))).toBe(DEFAULT_MODEL_ID);
    updateAiPreferences("acct-a", { preferredAssistantModel: null });
    expect(resolvePreferredModelId(loadAiPreferences("acct-a"))).toBe(DEFAULT_MODEL_ID);
  });

  it("falls back to safe defaults on unknown or corrupt stored values, never throwing", () => {
    window.localStorage.setItem(
      aiPreferencesKey("acct-bad"),
      JSON.stringify({
        assistantMode: "turbo",
        preferredAssistantModel: 42,
        photoEngine: "sometimes",
        matchesEngine: "needle-pro",
      }),
    );
    expect(loadAiPreferences("acct-bad")).toEqual(AI_PREFERENCES_DEFAULTS);
    window.localStorage.setItem(aiPreferencesKey("acct-bad"), "{not-json");
    expect(loadAiPreferences("acct-bad")).toEqual(AI_PREFERENCES_DEFAULTS);
  });

  it("only allows the needle matches engine with installed/verified evidence", () => {
    expect(isNeedleSelectable(null)).toBe(false);
    expect(
      isNeedleSelectable({ measured: true, correctnessPass: false, fresh: true }),
    ).toBe(false);
    expect(
      isNeedleSelectable({ measured: true, correctnessPass: true, fresh: true }),
    ).toBe(true);
  });

  it("exposes a Settings-owned binding: selectedId reads the default, onSelectModel persists it", () => {
    const binding = createAssistantModelBinding("acct-bind");
    expect(binding.selectedId).toBeNull();
    binding.onSelectModel("openrouter/free");
    expect(loadAiPreferences("acct-bind").preferredAssistantModel).toBe("openrouter/free");
    expect(createAssistantModelBinding("acct-bind").selectedId).toBe("openrouter/free");
    // Other accounts are untouched by the binding.
    expect(loadAiPreferences("acct-other").preferredAssistantModel).toBeNull();
  });

  it("publishes the effective photo engine to the slot the photo analyzer reads", () => {
    publishEffectivePhotoEngine({ ...AI_PREFERENCES_DEFAULTS, photoEngine: "cloud-only" });
    expect(window.localStorage.getItem(EFFECTIVE_PHOTO_ENGINE_KEY)).toBe("cloud-only");
    publishEffectivePhotoEngine({ ...AI_PREFERENCES_DEFAULTS, photoEngine: "on-device-only" });
    expect(window.localStorage.getItem(EFFECTIVE_PHOTO_ENGINE_KEY)).toBe("on-device-only");
  });

  it("maps the legacy assistant-mode vocabulary onto preferences (unknown stays automatic)", () => {
    expect(legacyAssistantModeToPreference("cloud-only")).toBe("cloud-only");
    expect(legacyAssistantModeToPreference("offline-only")).toBe("on-device-only");
    expect(legacyAssistantModeToPreference("offline-first")).toBe("on-device-only");
    expect(legacyAssistantModeToPreference("auto")).toBe("automatic");
    expect(legacyAssistantModeToPreference("turbo")).toBe("automatic");
  });

  it("maps preferences back onto the gate vocabulary fail-closed", () => {
    expect(preferenceToAssistantMode("automatic")).toBe("auto");
    expect(preferenceToAssistantMode("cloud-only")).toBe("cloud-only");
    expect(preferenceToAssistantMode("on-device-only")).toBe("offline-only");
  });

  it("migrates the legacy key once into the authoritative store and never consults it again", () => {
    window.localStorage.setItem("findback.ai.assistantMode.v1.acct-mig", "cloud-only");
    expect(loadSeededAiPreferences("acct-mig").assistantMode).toBe("cloud-only");
    expect(loadEffectiveAssistantMode("acct-mig")).toBe("cloud-only");
    // A later legacy change is ignored once the new store exists (single source).
    window.localStorage.setItem("findback.ai.assistantMode.v1.acct-mig", "offline-only");
    expect(loadSeededAiPreferences("acct-mig").assistantMode).toBe("cloud-only");
    expect(loadEffectiveAssistantMode("acct-mig")).toBe("cloud-only");
  });

  it("reads the safe default when neither store has a value", () => {
    expect(loadSeededAiPreferences("acct-fresh").assistantMode).toBe("automatic");
    expect(loadEffectiveAssistantMode("acct-fresh")).toBe("auto");
  });

  it("lets the assistant mode override the photo engine (on-device-only forbids cloud fallback)", () => {
    updateAiPreferences("acct-photo", { assistantMode: "on-device-only", photoEngine: "automatic" });
    expect(effectivePhotoEngine("acct-photo")).toBe("on-device-only");
    updateAiPreferences("acct-photo", { assistantMode: "cloud-only", photoEngine: "on-device-only" });
    expect(effectivePhotoEngine("acct-photo")).toBe("cloud-only");
    // Under automatic the account's own photoEngine choice applies.
    updateAiPreferences("acct-photo", { assistantMode: "automatic", photoEngine: "cloud-only" });
    expect(effectivePhotoEngine("acct-photo")).toBe("cloud-only");
    // Never crosses accounts.
    expect(effectivePhotoEngine("acct-other-photo")).toBe("automatic");
  });
});
