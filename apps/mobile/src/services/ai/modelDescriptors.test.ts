/**
 * Phase A (Step 2): canonical descriptor registry tests.
 *
 * No production logic may rely on catalogue position; these pin the named
 * lookup surface, catalogue derivation, duplicate rejection, and ABI truth
 * that Steps 3, 8, and 10 build on.
 */
import { describe, expect, it } from "vitest";
import {
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
import { NEEDLE_MODEL_ID } from "./needle/embedder";

describe("modelDescriptors", () => {
  it("cannot accidentally re-enable cleanup-only records through an exposed descriptor", () => {
    const registry = productionModelRegistry();
    const retired = registry.descriptors.filter((d) => d.cleanupOnly);
    expect(retired.length).toBeGreaterThan(0);
    for (const descriptor of retired) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Reflect.set(descriptor, "cleanupOnly", false)).toBe(false);
      expect(Reflect.set(descriptor, "downloadable", true)).toBe(false);
      expect(Object.isFrozen(descriptor.taskRoles)).toBe(true);
    }
  });
  it("production catalogue offers the retained helper, not retired generative downloads", () => {
    const registry = productionModelRegistry();
    expect(registry.catalogue().map((item) => item.modelId).sort()).toEqual(
      ["needle3-cact-l20"],
    );
    expect(productionModelRegistry()).toBe(registry);
  });

  it("retains Qwen's historical byte identity without promoting its former roles or acquisition", () => {
    const descriptor = productionModelRegistry().requireDescriptor(QWEN_TEXT_MODEL_ID);
    expect(profileFor(QWEN_TEXT_MODEL_ID)).toBeUndefined();
    expect(QWEN_TEXT_DESCRIPTOR.revision).toBe("a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76");
    expect(QWEN_TEXT_DESCRIPTOR.sha256).toBe("03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856");
    expect(QWEN_TEXT_DESCRIPTOR.format).toBe("litertlm");
    expect(QWEN_TEXT_DESCRIPTOR.maturity).toBe("production");
    expect(tierOf(QWEN_TEXT_DESCRIPTOR)).toBe("recommended");
    expect(descriptor.downloadable).toBe(false);
    expect(distributionPolicyOf(descriptor)).toBe("unavailable");
    expect(descriptor.taskRoles).toEqual([]);
    expect(descriptor.cleanupOnly).toBe(true);
    expect(modelSupportsAbi(QWEN_TEXT_DESCRIPTOR, "arm64-v8a")).toBe(true);
    expect(modelSupportsAbi(QWEN_TEXT_DESCRIPTOR, "x86_64")).toBe(false);
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
        // Cleanup identities retain their real historical URL/bytes; policy,
        // not erasing file identity, prevents new acquisition.
        if (!descriptor.cleanupOnly) expect(descriptor.url).toBe("");
        expect(distributionPolicyOf(descriptor)).not.toBe("downloadable");
      }
    }
  });

  it("resolves the vision model from explicit policy, never catalogue order", () => {
    const synthetic = { ...SMOL_VISION_DESCRIPTOR, modelId: "test-vision", cleanupOnly: false };
    const reordered = createModelRegistry([synthetic, NEEDLE_DESCRIPTOR], {
      defaultVisionModelId: synthetic.modelId,
    });
    expect(reordered.visionDescriptor()?.modelId).toBe("test-vision");
    expect(reordered.descriptorFor(NEEDLE_MODEL_ID)?.runtimeId).toBe("needle-cact");
    expect(reordered.descriptorFor("nope")).toBeUndefined();
    expect(() => reordered.requireDescriptor("nope")).toThrow(/unknown on-device model/i);
  });

  it("never routes a cleanup identity even when explicitly configured as the vision default", () => {
    const registry = createModelRegistry([SMOL_VISION_DESCRIPTOR], {
      defaultVisionModelId: SMOL_VISION_DESCRIPTOR.modelId,
    });
    expect(registry.visionDescriptor()).toBeUndefined();
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
    // Routing proof: embeddings are a descriptor role, so the routing
    // authority advertises it even though the lab profile omits it.
    expect(NEEDLE_DESCRIPTOR.taskRoles).toContain("embed-texts");
  });
});
