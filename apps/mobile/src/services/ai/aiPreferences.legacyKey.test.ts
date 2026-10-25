// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { aiPreferencesKey, legacyAssistantModeKey, loadSeededAiPreferences, updateAiPreferences } from "./aiPreferences";

afterEach(() => localStorage.clear());

it("reads the original per-account mode key once without writing legacy values", () => {
  // Seed the old bytes independently of the relocated key helper.
  localStorage.setItem("findback.ai.assistantMode.v1.owner-a", "offline-only");
  expect(legacyAssistantModeKey("owner-a")).toBe("findback.ai.assistantMode.v1.owner-a");
  expect(loadSeededAiPreferences("owner-a").assistantMode).toBe("on-device-only");
  expect(localStorage.getItem(legacyAssistantModeKey("owner-a"))).toBe("offline-only");
  updateAiPreferences("owner-a", { assistantMode: "cloud-only" });
  expect(loadSeededAiPreferences("owner-a").assistantMode).toBe("cloud-only");
  expect(localStorage.getItem(legacyAssistantModeKey("owner-a"))).toBe("offline-only");
  expect(loadSeededAiPreferences("owner-b").assistantMode).toBe("automatic");
  expect(localStorage.getItem(aiPreferencesKey("owner-b"))).toBeNull();
});
