import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_VISION_MODEL_ID,
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_TOOL_MODEL_ID,
  automaticLocalModel,
  displayNameForCatalogRecord,
  isAssistantSelectableOfflineRecord,
  isConversationalUiRole,
  qualifiedUiRolesForOfflineModel,
  rolesForCatalogRecord,
  supportsAssistantMessage,
} from "./uiModelRoles";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { productionModelRegistry, QWEN_TEXT_MODEL_ID, SMOL_VISION_MODEL_ID } from "./modelDescriptors";
import type { ModelRecord } from "./providerContract";

const row = (id: string, provider: ModelRecord["provider"], qualifiedRoles?: ModelRecord["qualifiedRoles"]): ModelRecord => ({
  id, provider, qualifiedRoles, input: ["text"], output: ["text"], prices: [],
  priceClass: "unknown", retrievedAt: "2026-10-08T00:00:00.000Z", entitlement: "untested",
});

describe("uiModelRoles (master plan §8)", () => {
  it("qualifies Needle as Tools + Embeddings, never Chat or Vision", () => {
    const roles = qualifiedUiRolesForOfflineModel(NEEDLE_MODEL_ID);
    expect(roles).toContain("tools");
    expect(roles).toContain("embeddings");
    expect(roles).not.toContain("chat");
    expect(roles).not.toContain("vision");
  });

  it("does not qualify the retired vision model", () => {
    expect(qualifiedUiRolesForOfflineModel(SMOL_VISION_MODEL_ID)).toEqual([]);
  });

  it("does not qualify the retired prose model for any consumer role", () => {
    const roles = qualifiedUiRolesForOfflineModel(QWEN_TEXT_MODEL_ID);
    expect(roles).not.toContain("chat");
    // Qwen-only install must NOT claim report filling it cannot serve.
    expect(roles).not.toContain("tools");
    expect(roles).not.toContain("vision");
    expect(roles).not.toContain("embeddings");
  });

  it("has no local conversational defaults or retired Assistant selection", () => {
    expect(DEFAULT_CHAT_MODEL_ID).toBeUndefined();
    expect(DEFAULT_VISION_MODEL_ID).toBeUndefined();
    expect(
      isAssistantSelectableOfflineRecord({ id: QWEN_TEXT_MODEL_ID, provider: "offline" }),
    ).toBe(false);
  });

  it("never treats cleanup metadata capabilities as consumer role qualification", () => {
    const registry = productionModelRegistry();
    const retired = registry.requireDescriptor(QWEN_TEXT_MODEL_ID);
    const lookup = vi.spyOn(registry, "descriptorFor").mockReturnValue({ ...retired, capabilities: ["embedding", "matching"] });
    try { expect(qualifiedUiRolesForOfflineModel(retired.modelId)).toEqual([]); }
    finally { lookup.mockRestore(); }
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

  it("excludes the narrow helper and retired generation models from Assistant selection", () => {
    expect(isAssistantSelectableOfflineRecord({ id: NEEDLE_MODEL_ID, provider: "offline" })).toBe(false);
    expect(isAssistantSelectableOfflineRecord({ id: SMOL_VISION_MODEL_ID, provider: "offline" })).toBe(false);
    expect(isAssistantSelectableOfflineRecord({ id: QWEN_TEXT_MODEL_ID, provider: "offline" })).toBe(false);
  });

  it("also requires explicit conversation qualification on cloud selection rows", () => {
    expect(isAssistantSelectableOfflineRecord({ id: "unknown", provider: "openrouter" })).toBe(false);
    expect(isAssistantSelectableOfflineRecord({ id: "voice", provider: "groq", qualifiedRoles: ["stt"] })).toBe(false);
    expect(isAssistantSelectableOfflineRecord({ id: "openrouter/free", provider: "openrouter", qualifiedRoles: ["chat"] })).toBe(true);
  });

  it("derives offline roles from qualification rather than text I/O", () => {
    expect(rolesForCatalogRecord({ id: NEEDLE_MODEL_ID, provider: "offline", input: ["text"] })).toEqual([
      "tools",
      "embeddings",
    ]);
    expect(rolesForCatalogRecord({ id: SMOL_VISION_MODEL_ID, provider: "offline", input: ["text", "image"] })).toEqual([]);
  });

  it("fails closed for cloud text and image shapes without qualification", () => {
    expect(rolesForCatalogRecord({ id: "whisper-large-v3", provider: "groq", input: ["text"] })).toEqual([]);
    expect(rolesForCatalogRecord({ id: "unknown-image-tool", provider: "openrouter", input: ["text", "image"] })).toEqual([]);
  });

  it("uses explicit cloud roles, including speech, without adding Chat", () => {
    expect(rolesForCatalogRecord({ id: "voice", provider: "groq", input: ["audio"], qualifiedRoles: ["stt"] })).toEqual(["stt"]);
    expect(rolesForCatalogRecord({ id: "vlm", provider: "openrouter", input: ["image"], qualifiedRoles: ["vision"] })).toEqual(["vision"]);
    expect(rolesForCatalogRecord({ id: "chat", provider: "openai", input: [], qualifiedRoles: ["chat", "vision"] })).toEqual(["chat", "vision"]);
  });

  it("names explicit single-candidate role defaults instead of registry order", () => {
    expect(DEFAULT_TOOL_MODEL_ID).toBe(NEEDLE_MODEL_ID);
    expect(DEFAULT_EMBEDDING_MODEL_ID).toBe(NEEDLE_MODEL_ID);
  });

  it("ignores forged local cached role claims and malformed cloud role metadata", () => {
    expect(rolesForCatalogRecord(row(NEEDLE_MODEL_ID, "offline", ["chat"]))).toEqual(["tools", "embeddings"]);
    expect(rolesForCatalogRecord(row("speech", "groq", ["chat", "bogus"] as unknown as ModelRecord["qualifiedRoles"]))).toEqual([]);
    expect(rolesForCatalogRecord(row("speech", "groq", "chat" as unknown as ModelRecord["qualifiedRoles"]))).toEqual([]);
  });

  it("refuses retired local send and Automatic choices even when their rows remain installed", () => {
    const smol = row(SMOL_VISION_MODEL_ID, "offline");
    const needle = row(NEEDLE_MODEL_ID, "offline");
    const qwen = row(QWEN_TEXT_MODEL_ID, "offline");
    expect(supportsAssistantMessage(smol, false)).toBe(false);
    expect(supportsAssistantMessage(smol, true)).toBe(false);
    expect(supportsAssistantMessage(needle, false)).toBe(false);
    expect(supportsAssistantMessage(qwen, false)).toBe(false);
    expect(supportsAssistantMessage(qwen, true)).toBe(false);
    expect(supportsAssistantMessage(row("speech", "groq", ["stt"]), false)).toBe(false);
    expect(supportsAssistantMessage(row("unknown", "openrouter"), false)).toBe(false);
    expect(automaticLocalModel([needle, smol], true)).toBeNull();
    expect(automaticLocalModel([needle, smol, qwen], false)).toBeNull();
    expect(automaticLocalModel([qwen, needle], false)).toBeNull();
    expect(automaticLocalModel([smol, needle], false)).toBeNull();
  });

  it("exports a display-name resolver usable by the composer without I/O metadata", () => {
    expect(displayNameForCatalogRecord({ id: NEEDLE_MODEL_ID, provider: "offline" })).toBe("Needle3");
    expect(displayNameForCatalogRecord({ id: SMOL_VISION_MODEL_ID, provider: "offline" })).toBe("SmolVLM2");
    expect(displayNameForCatalogRecord({ id: QWEN_TEXT_MODEL_ID, provider: "offline" })).toBe("Qwen3");
    expect(displayNameForCatalogRecord({ id: "gpt-4o-mini", provider: "openai", displayName: "gpt-4o-mini" })).toBe("GPT-4o mini");
    expect(displayNameForCatalogRecord({ id: "technical/opaque", provider: "generic", displayName: "technical/opaque" })).toBe("Cloud model");
    expect(displayNameForCatalogRecord({ id: "unregistered", provider: "offline" })).toBe("On-device model");
  });
});
