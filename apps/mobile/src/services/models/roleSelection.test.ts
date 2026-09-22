// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { SHIPPED_CATALOGUE_ENTRIES } from "./shippedCatalogue";
import {
  DEFAULT_IMAGE_ENTRY_ID,
  DEFAULT_TEXT_ENTRY_ID,
  PREFERRED_IMAGE_KEY,
  PREFERRED_TEXT_KEY,
  RESIDENT_ENTRY_KEY,
  defaultEntryIdForRole,
  entryRole,
  loadPreferredEntryId,
  loadResidentEntryId,
  planRoleSwitch,
  resolveEntryForRole,
  resolvePreferredEntryId,
  routeRoleRequest,
  savePreferredEntryId,
  saveResidentEntryId,
  validateRoleAssignment,
} from "./roleSelection";
import { QWEN_TEXT_ENTRY_ID } from "./textRuntime";

const SMOLVLM_ENTRY_ID = "smolvlm2-500m-litert-int4";
const LFM_TEXT_ENTRY_ID = "lfm2.5-1.2b-instruct-litert-int4-gpu";
const LFM_VL_ENTRY_ID = "lfm2.5-vl-450m";
const GEMMA_ENTRY_ID = "gemma-3n-e2b-it-litert-int4";

function entryById(id: string) {
  const entry = SHIPPED_CATALOGUE_ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`missing shipped entry: ${id}`);
  return entry;
}

beforeEach(() => {
  window.localStorage.removeItem(PREFERRED_TEXT_KEY);
  window.localStorage.removeItem(PREFERRED_IMAGE_KEY);
  window.localStorage.removeItem(RESIDENT_ENTRY_KEY);
});

describe("role preference defaults", () => {
  it("prefers Qwen for text and SmolVLM2 for image", () => {
    expect(DEFAULT_TEXT_ENTRY_ID).toBe(QWEN_TEXT_ENTRY_ID);
    expect(DEFAULT_IMAGE_ENTRY_ID).toBe(SMOLVLM_ENTRY_ID);
    expect(defaultEntryIdForRole("text")).toBe(QWEN_TEXT_ENTRY_ID);
    expect(defaultEntryIdForRole("image")).toBe(SMOLVLM_ENTRY_ID);
    expect(resolvePreferredEntryId("text")).toBe(QWEN_TEXT_ENTRY_ID);
    expect(resolvePreferredEntryId("image")).toBe(SMOLVLM_ENTRY_ID);
  });

  it("round-trips saves through storage", () => {
    expect(savePreferredEntryId("text", QWEN_TEXT_ENTRY_ID)).toEqual({ ok: true });
    expect(savePreferredEntryId("image", SMOLVLM_ENTRY_ID)).toEqual({ ok: true });
    expect(loadPreferredEntryId("text")).toBe(QWEN_TEXT_ENTRY_ID);
    expect(loadPreferredEntryId("image")).toBe(SMOLVLM_ENTRY_ID);
  });

  it("shares the single resident record with the library screen", () => {
    saveResidentEntryId(SMOLVLM_ENTRY_ID);
    expect(loadResidentEntryId()).toBe(SMOLVLM_ENTRY_ID);
    expect(window.localStorage.getItem(RESIDENT_ENTRY_KEY)).toBe(SMOLVLM_ENTRY_ID);
  });
});

describe("validateRoleAssignment", () => {
  it("accepts the qualified entries for their own roles", () => {
    expect(validateRoleAssignment("text", QWEN_TEXT_ENTRY_ID).ok).toBe(true);
    expect(validateRoleAssignment("image", SMOLVLM_ENTRY_ID).ok).toBe(true);
  });

  it("refuses cross-role ids without persisting them", () => {
    const textAsImage = savePreferredEntryId("image", QWEN_TEXT_ENTRY_ID);
    expect(textAsImage.ok).toBe(false);
    expect(textAsImage).toMatchObject({ ok: false });
    if (!textAsImage.ok) expect(textAsImage.reason).toMatch(/Cross-role routing refused/);
    expect(loadPreferredEntryId("image")).toBeNull();

    const imageAsText = savePreferredEntryId("text", SMOLVLM_ENTRY_ID);
    expect(imageAsText.ok).toBe(false);
    if (!imageAsText.ok) expect(imageAsText.reason).toMatch(/Cross-role routing refused/);
    expect(loadPreferredEntryId("text")).toBeNull();
  });

  it("refuses unknown, catalogue-only, experimental, and incompatible ids", () => {
    expect(validateRoleAssignment("text", "no-such-model")).toMatchObject({ ok: false });
    expect(validateRoleAssignment("text", GEMMA_ENTRY_ID)).toMatchObject({ ok: false });
    expect(validateRoleAssignment("text", LFM_TEXT_ENTRY_ID)).toMatchObject({ ok: false });
    expect(validateRoleAssignment("image", LFM_VL_ENTRY_ID)).toMatchObject({ ok: false });
  });
});

describe("entryRole", () => {
  it("maps catalogue roles to text, image, or neither", () => {
    expect(entryRole(entryById(QWEN_TEXT_ENTRY_ID))).toBe("text");
    expect(entryRole(entryById(SMOLVLM_ENTRY_ID))).toBe("image");
    expect(entryRole(entryById(GEMMA_ENTRY_ID))).toBe("other");
  });
});

describe("routeRoleRequest", () => {
  it("routes matching roles and refuses crossed ones", () => {
    expect(routeRoleRequest("text", entryById(QWEN_TEXT_ENTRY_ID)).ok).toBe(true);
    expect(routeRoleRequest("image", entryById(SMOLVLM_ENTRY_ID)).ok).toBe(true);
    const imageToText = routeRoleRequest("text", entryById(SMOLVLM_ENTRY_ID));
    expect(imageToText.ok).toBe(false);
    if (!imageToText.ok) expect(imageToText.reason).toMatch(/Cross-role routing refused/);
    const textToImage = routeRoleRequest("image", entryById(QWEN_TEXT_ENTRY_ID));
    expect(textToImage.ok).toBe(false);
    if (!textToImage.ok) expect(textToImage.reason).toMatch(/Cross-role routing refused/);
  });
});

describe("resolveEntryForRole", () => {
  it("resolves stored preferences, else the defaults", () => {
    expect(resolveEntryForRole("text")).toMatchObject({
      ok: true,
      entry: expect.objectContaining({ id: QWEN_TEXT_ENTRY_ID }),
    });
    expect(resolveEntryForRole("image")).toMatchObject({
      ok: true,
      entry: expect.objectContaining({ id: SMOLVLM_ENTRY_ID }),
    });
  });

  it("fails closed on a corrupt stored value instead of substituting", () => {
    window.localStorage.setItem(PREFERRED_TEXT_KEY, "no-such-model");
    const resolved = resolveEntryForRole("text");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/no-such-model/);
  });
});

describe("planRoleSwitch", () => {
  const base = {
    availableFreeRamMb: 4096 as number | null,
    advancedConfirmed: false,
    textRuntimePresent: true,
  };

  it("plans release-then-load of Qwen for a text need while the image model is resident", () => {
    const plan = planRoleSwitch({
      ...base,
      role: "text",
      currentResidentId: SMOLVLM_ENTRY_ID,
    });
    expect(plan).toEqual({
      blocked: false,
      targetEntryId: QWEN_TEXT_ENTRY_ID,
      steps: ["cancel", "release", "verify-memory", "init"],
    });
  });

  it("plans release-then-load of SmolVLM2 for an image need while Qwen is resident", () => {
    const plan = planRoleSwitch({
      ...base,
      role: "image",
      currentResidentId: QWEN_TEXT_ENTRY_ID,
    });
    expect(plan).toEqual({
      blocked: false,
      targetEntryId: SMOLVLM_ENTRY_ID,
      steps: ["cancel", "release", "verify-memory", "init"],
    });
  });

  it("plans no steps when the preferred entry is already resident (single resident, no double-load)", () => {
    expect(
      planRoleSwitch({ ...base, role: "text", currentResidentId: QWEN_TEXT_ENTRY_ID }),
    ).toEqual({ blocked: false, targetEntryId: QWEN_TEXT_ENTRY_ID, steps: [] });
    expect(
      planRoleSwitch({ ...base, role: "image", currentResidentId: SMOLVLM_ENTRY_ID }),
    ).toEqual({ blocked: false, targetEntryId: SMOLVLM_ENTRY_ID, steps: [] });
  });

  it("keeps the release-before-init order so two engines are never resident together", () => {
    const plan = planRoleSwitch({ ...base, role: "text", currentResidentId: null });
    expect(plan.blocked).toBe(false);
    if (!plan.blocked) {
      expect(plan.steps.indexOf("release")).toBeLessThan(plan.steps.indexOf("init"));
    }
  });

  it("refuses a tampered cross-role preference instead of switching to it", () => {
    const plan = planRoleSwitch({
      ...base,
      role: "text",
      currentResidentId: SMOLVLM_ENTRY_ID,
      preferredEntryId: SMOLVLM_ENTRY_ID,
    });
    expect(plan.blocked).toBe(true);
    if (plan.blocked) expect(plan.reason).toMatch(/Cross-role routing refused/);
    const mirrored = planRoleSwitch({
      ...base,
      role: "image",
      currentResidentId: QWEN_TEXT_ENTRY_ID,
      preferredEntryId: QWEN_TEXT_ENTRY_ID,
    });
    expect(mirrored.blocked).toBe(true);
    if (mirrored.blocked) expect(mirrored.reason).toMatch(/Cross-role routing refused/);
  });

  it("blocks text while the text runtime is absent, so the caller keeps the grounded fallback", () => {
    const plan = planRoleSwitch({
      ...base,
      role: "text",
      currentResidentId: SMOLVLM_ENTRY_ID,
      textRuntimePresent: false,
    });
    expect(plan).toMatchObject({ blocked: true });
    if (plan.blocked) expect(plan.reason).toMatch(/no executable runtime/i);
  });
});
