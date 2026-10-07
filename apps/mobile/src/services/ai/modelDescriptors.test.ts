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
  modelSupportsAbi,
  NEEDLE_DESCRIPTOR,
  productionModelRegistry,
  SMOL_VISION_DESCRIPTOR,
} from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";

describe("modelDescriptors", () => {
  it("production registry carries exactly Needle + SmolVLM2 vision", () => {
    const registry = productionModelRegistry();
    expect(registry.descriptors.map((item) => item.modelId).sort()).toEqual(
      [NEEDLE_MODEL_ID, SMOL_VISION_DESCRIPTOR.modelId].sort(),
    );
    expect(registry.catalogue()).toHaveLength(2);
    expect(productionModelRegistry()).toBe(registry);
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
});
