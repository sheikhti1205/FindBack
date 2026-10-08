import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_TOOL_MODEL_ID,
  isAssistantSelectableOfflineRecord,
  isConversationalUiRole,
  qualifiedUiRolesForOfflineModel,
  rolesForCatalogRecord,
} from "./uiModelRoles";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { SMOL_VISION_MODEL_ID } from "./modelDescriptors";

describe("uiModelRoles (master plan §8)", () => {
  it("qualifies Needle as Tools + Embeddings, never Chat or Vision", () => {
    const roles = qualifiedUiRolesForOfflineModel(NEEDLE_MODEL_ID);
    expect(roles).toContain("tools");
    expect(roles).toContain("embeddings");
    expect(roles).not.toContain("chat");
    expect(roles).not.toContain("vision");
  });

  it("qualifies SmolVLM2 as Vision only until chat evidence exists", () => {
    expect(qualifiedUiRolesForOfflineModel(SMOL_VISION_MODEL_ID)).toEqual(["vision"]);
  });

  it("fails closed for unknown model ids instead of inferring from I/O shape", () => {
    expect(qualifiedUiRolesForOfflineModel("some-future-text-model")).toEqual([]);
  });

  it("treats only chat and vision as conversational", () => {
    expect(isConversationalUiRole("chat")).toBe(true);
    expect(isConversationalUiRole("vision")).toBe(true);
    expect(isConversationalUiRole("tools")).toBe(false);
    expect(isConversationalUiRole("embeddings")).toBe(false);
    expect(isConversationalUiRole("stt")).toBe(false);
    expect(isConversationalUiRole("tts")).toBe(false);
  });

  it("excludes Needle rows from Assistant selection but keeps SmolVLM2", () => {
    expect(isAssistantSelectableOfflineRecord({ id: NEEDLE_MODEL_ID, provider: "offline" })).toBe(false);
    expect(isAssistantSelectableOfflineRecord({ id: SMOL_VISION_MODEL_ID, provider: "offline" })).toBe(true);
  });

  it("leaves cloud rows to the provider catalogue path", () => {
    expect(isAssistantSelectableOfflineRecord({ id: "openrouter/free", provider: "openrouter" })).toBe(true);
  });

  it("derives catalogue roles per row: offline qualified, cloud conversational by contract", () => {
    expect(rolesForCatalogRecord({ id: NEEDLE_MODEL_ID, provider: "offline", input: ["text"] })).toEqual([
      "tools",
      "embeddings",
    ]);
    expect(rolesForCatalogRecord({ id: SMOL_VISION_MODEL_ID, provider: "offline", input: ["text", "image"] })).toEqual([
      "vision",
    ]);
    expect(rolesForCatalogRecord({ id: "openrouter/free", provider: "openrouter", input: ["text"] })).toEqual(["chat"]);
    expect(rolesForCatalogRecord({ id: "groq-vision", provider: "groq", input: ["text", "image"] })).toEqual([
      "chat",
      "vision",
    ]);
  });

  it("names explicit single-candidate role defaults instead of registry order", () => {
    expect(DEFAULT_TOOL_MODEL_ID).toBe(NEEDLE_MODEL_ID);
    expect(DEFAULT_EMBEDDING_MODEL_ID).toBe(NEEDLE_MODEL_ID);
  });
});
