import { describe, expect, it } from "vitest";
import {
  isAssistantSelectableOfflineRecord,
  isConversationalUiRole,
  qualifiedUiRolesForOfflineModel,
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
});
