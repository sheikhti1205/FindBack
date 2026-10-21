// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadCloudModelPreferences, saveCloudModelDefault, toggleCloudFavorite, recordCloudModelUsed, CLOUD_DEFAULT_ROUTE } from "./cloudModelPreferences";
import { updateAiPreferences } from "./aiPreferences";
import type { ModelRecord } from "./providerContract";
afterEach(() => localStorage.clear());
const model = { provider: "deepseek" as const, modelId: "my-model" };
describe("account-scoped cloud model preferences", () => {
  it("keeps provider-qualified defaults, favorites and recent use separate between accounts", () => {
    saveCloudModelDefault("a", model);
    toggleCloudFavorite("a", model);
    recordCloudModelUsed("a", model);
    expect(loadCloudModelPreferences("a")).toMatchObject({ defaultModel: model, favorites: [model], lastUsed: [model] });
    expect(loadCloudModelPreferences("b")).toEqual({ defaultModel: null, favorites: [], lastUsed: [] });
  });
  it("deduplicates recents and distinguishes the same model ID at different providers", () => {
    recordCloudModelUsed("a", model);
    recordCloudModelUsed("a", { ...model, provider: "openai" });
    recordCloudModelUsed("a", model);
    expect(loadCloudModelPreferences("a").lastUsed).toEqual([model, { ...model, provider: "openai" }]);
    toggleCloudFavorite("a", model); toggleCloudFavorite("a", model);
    expect(loadCloudModelPreferences("a").favorites).toEqual([]);
  });
  it("migrates a uniquely resolved legacy cloud default once, never mirrors later legacy writes", () => {
    updateAiPreferences("a", { preferredAssistantModel: "my-model" });
    const rows = [{ provider: "deepseek", id: "my-model" }] as ModelRecord[];
    expect(loadCloudModelPreferences("a", rows).defaultModel).toEqual(model);
    updateAiPreferences("a", { preferredAssistantModel: "different" });
    expect(loadCloudModelPreferences("a").defaultModel).toEqual(model);
  });
  it("migrates the canonical legacy default to the canonical cloud route", () => {
    updateAiPreferences("a", { preferredAssistantModel: "openrouter/free" });
    expect(loadCloudModelPreferences("a").defaultModel).toEqual(CLOUD_DEFAULT_ROUTE);
  });
  it("never guesses the provider of an unresolved, local or ambiguous legacy default", () => {
    updateAiPreferences("a", { preferredAssistantModel: "my-model" });
    expect(loadCloudModelPreferences("a").defaultModel).toBeNull();
    expect(loadCloudModelPreferences("a", [{ provider: "offline", id: "my-model" }] as ModelRecord[]).defaultModel).toBeNull();
    expect(loadCloudModelPreferences("a", [{ provider: "openai", id: "my-model" }, { provider: "deepseek", id: "my-model" }] as ModelRecord[]).defaultModel).toBeNull();
  });
});
