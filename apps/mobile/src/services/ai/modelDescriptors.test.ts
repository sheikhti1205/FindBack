/**
 * Phase A (Step 2): canonical descriptor registry tests.
 *
 * No production logic may rely on catalogue position; these pin the named
 * lookup surface, catalogue derivation, duplicate rejection, and ABI truth
 * that Steps 3, 8, and 10 build on.
 */
import { describe, expect, it } from "vitest";
import {
  ADVANCED_DESCRIPTORS,
  createModelRegistry,
  distributionPolicyOf,
  modelSupportsAbi,
  NEEDLE_DESCRIPTOR,
  productionModelRegistry,
  QWEN_TEXT_DESCRIPTOR,
  QWEN_TEXT_MODEL_ID,
  SMOL_VISION_DESCRIPTOR,
  tierOf,
} from "./modelDescriptors";
import { profileFor } from "./modelProfiles";
import { qualifiedUiRolesForOfflineModel } from "./uiModelRoles";
import { NEEDLE_MODEL_ID } from "./needle/embedder";

describe("modelDescriptors", () => {
  it("production catalogue offers exactly the verified Recommended downloads (Needle + SmolVLM2 vision + Qwen3 text)", () => {
    const registry = productionModelRegistry();
    expect(registry.catalogue().map((item) => item.modelId).sort()).toEqual(
      [NEEDLE_MODEL_ID, SMOL_VISION_DESCRIPTOR.modelId, QWEN_TEXT_MODEL_ID].sort(),
    );
    expect(productionModelRegistry()).toBe(registry);
  });

  it("keeps one canonical registry: every product-visible model has a descriptor, Advanced never a shadow list", () => {
    const registry = productionModelRegistry();
    const ids = registry.descriptors.map((item) => item.modelId);
    for (const advanced of ADVANCED_DESCRIPTORS) {
      expect(ids).toContain(advanced.modelId);
      expect(registry.descriptorFor(advanced.modelId)).toBe(advanced);
    }
    expect(registry.advancedCatalogue().map((item) => item.modelId).sort()).toEqual(
      ADVANCED_DESCRIPTORS.map((item) => item.modelId).sort(),
    );
    // Catalogue and Advanced never overlap: one authority, no double rows.
    const catalogueIds = new Set(registry.catalogue().map((item) => item.modelId));
    for (const advanced of registry.advancedCatalogue()) {
      expect(catalogueIds.has(advanced.modelId)).toBe(false);
    }
  });

  it("promotes Qwen3 0.6B as Recommended production text with pins reused from its lab profile", () => {
    const profile = profileFor(QWEN_TEXT_MODEL_ID);
    expect(profile).toBeDefined();
    expect(QWEN_TEXT_DESCRIPTOR.revision).toBe(profile!.revision);
    expect(QWEN_TEXT_DESCRIPTOR.sha256).toBe(profile!.modelSha256);
    expect(QWEN_TEXT_DESCRIPTOR.format).toBe("litertlm");
    expect(QWEN_TEXT_DESCRIPTOR.maturity).toBe("production");
    expect(tierOf(QWEN_TEXT_DESCRIPTOR)).toBe("recommended");
    expect(QWEN_TEXT_DESCRIPTOR.downloadable).toBe(true);
    expect(distributionPolicyOf(QWEN_TEXT_DESCRIPTOR)).toBe("downloadable");
    expect(QWEN_TEXT_DESCRIPTOR.taskRoles).toContain("answer-help");
    expect(modelSupportsAbi(QWEN_TEXT_DESCRIPTOR, "arm64-v8a")).toBe(true);
    expect(modelSupportsAbi(QWEN_TEXT_DESCRIPTOR, "x86_64")).toBe(false);
  });

  it("offers pinned Advanced acquisition without claiming device qualification or product roles", () => {
    const registry = productionModelRegistry();
    for (const descriptor of registry.advancedCatalogue()) {
      expect(tierOf(descriptor)).toBe("advanced");
      expect(descriptor.downloadable).toBe(true);
      expect(descriptor.taskRoles).toEqual([]);
      expect(descriptor.maturity).toBe("lab");
      expect(descriptor.deviceQualifiedAbis).toEqual([]);
      expect(distributionPolicyOf(descriptor)).toBe("downloadable");
      expect(descriptor.importable).toBe(true);
      expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(descriptor.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(descriptor.bytes).toBeGreaterThan(0);
      expect(descriptor.url).toContain(`/resolve/${descriptor.revision}/`);
    }
    // The 1.7B artifact has exact upstream metadata and an independent
    // minimum-runtime requirement, not the old guessed pending pin.
    const qwen17 = registry.descriptorFor("qwen3-1.7b-dynamic-int4");
    expect(qwen17?.sha256).toBe("2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8");
    expect(qwen17?.minRuntimeVersion).toBe("0.18.0");
  });

  it("never advertises an install action this build cannot perform", () => {
    const registry = productionModelRegistry();
    // Regression: Advanced rows once said "Available for import and evaluation"
    // while no import action existed anywhere. No note may mention an import
    // path this build does not ship.
    const PROMISES_IMPORT = /\bimport(?:s|ed|ing)?\b/i;
    for (const descriptor of registry.descriptors) {
      expect(descriptor.distributionNote ?? "").not.toMatch(PROMISES_IMPORT);
      if (!descriptor.downloadable) {
        // No install path of any kind: no URL and no fabricated bytes.
        expect(descriptor.url).toBe("");
        expect(distributionPolicyOf(descriptor)).not.toBe("downloadable");
      }
    }
  });

  it("resolves the vision model from explicit policy, never catalogue order", () => {
    const reordered = createModelRegistry([SMOL_VISION_DESCRIPTOR, NEEDLE_DESCRIPTOR], {
      defaultVisionModelId: SMOL_VISION_DESCRIPTOR.modelId,
    });
    expect(reordered.visionDescriptor()?.modelId).toBe(SMOL_VISION_DESCRIPTOR.modelId);
    expect(reordered.descriptorFor(NEEDLE_MODEL_ID)?.runtimeId).toBe("needle-cact");
    expect(reordered.descriptorFor("nope")).toBeUndefined();
    expect(() => reordered.requireDescriptor("nope")).toThrow(/unknown on-device model/i);
  });

  it("names no vision default unless the registry configures one", () => {
    const unconfigured = createModelRegistry([SMOL_VISION_DESCRIPTOR, NEEDLE_DESCRIPTOR]);
    expect(unconfigured.visionDescriptor()).toBeUndefined();
  });

  it("rejects a vision default that is not registered", () => {
    expect(() =>
      createModelRegistry([NEEDLE_DESCRIPTOR], { defaultVisionModelId: SMOL_VISION_DESCRIPTOR.modelId }),
    ).toThrow(/not registered/i);
  });

  it("rejects duplicate model ids instead of building a split-brain registry", () => {
    expect(() => createModelRegistry([NEEDLE_DESCRIPTOR, NEEDLE_DESCRIPTOR])).toThrow(/duplicate/i);
  });

  it("binds immutable pins from the model profiles, never invented values", () => {
    expect(NEEDLE_DESCRIPTOR.revision.length).toBeGreaterThan(0);
    expect(NEEDLE_DESCRIPTOR.sha256).toHaveLength(64);
    expect(SMOL_VISION_DESCRIPTOR.revision).toHaveLength(40);
    expect(SMOL_VISION_DESCRIPTOR.sha256).toHaveLength(64);
    expect(SMOL_VISION_DESCRIPTOR.format).toBe("litertlm");
    expect(NEEDLE_DESCRIPTOR.format).toBe("cact");
  });

  it("reports ABI truth: verified arm64 only, unknown ABI never counts", () => {
    expect(modelSupportsAbi(NEEDLE_DESCRIPTOR, "arm64-v8a")).toBe(true);
    expect(modelSupportsAbi(NEEDLE_DESCRIPTOR, "x86_64")).toBe(false);
    expect(modelSupportsAbi(SMOL_VISION_DESCRIPTOR, "x86_64")).toBe(false);
    expect(modelSupportsAbi(NEEDLE_DESCRIPTOR, "")).toBe(false);
  });

  it("declares descriptor.taskRoles the ONE authoritative production role map (L-CONSOLIDATE)", () => {
    // Production advertised roles live on the descriptor, not the lab profile.
    expect([...NEEDLE_DESCRIPTOR.taskRoles]).toEqual([
      "extract-report-fields",
      "extract-search-filters",
      "classify-category",
      "embed-texts",
    ]);
    // Lab profile roles are descriptive evidence and may be narrower: the
    // needle lab pin evidences extraction only, yet production serves the
    // full descriptor set — routing must never read the profile field.
    const needleProfileRoles = profileFor(NEEDLE_MODEL_ID)?.roles ?? [];
    for (const role of needleProfileRoles) {
      expect(NEEDLE_DESCRIPTOR.taskRoles).toContain(role);
    }
    expect(needleProfileRoles).not.toContain("embed-texts");
    // Routing proof: consumer qualification derives embeddings from the
    // descriptor's embed-texts role (the lab profile alone yields no such
    // signal through task roles).
    expect(qualifiedUiRolesForOfflineModel(NEEDLE_MODEL_ID)).toContain("embeddings");
    expect(qualifiedUiRolesForOfflineModel(NEEDLE_MODEL_ID)).toContain("tools");
    expect(qualifiedUiRolesForOfflineModel(NEEDLE_MODEL_ID)).not.toContain("chat");
  });
});
