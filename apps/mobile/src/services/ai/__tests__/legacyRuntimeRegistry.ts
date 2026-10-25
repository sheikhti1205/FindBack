import { ADVANCED_DESCRIPTORS, NEEDLE_DESCRIPTOR, QWEN_TEXT_DESCRIPTOR, SMOL_VISION_DESCRIPTOR } from "../modelDescriptors";

/** Isolated pre-retirement registry for generic engine/transaction contracts.
 * NEVER used by production or counted as current model availability. Default
 * production retirement is covered without this fixture in applicationAi.retirement.test.ts. */
export const legacyRuntimeRegistry = {
  descriptors: [NEEDLE_DESCRIPTOR, QWEN_TEXT_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, ...ADVANCED_DESCRIPTORS],
  defaultVisionModelId: SMOL_VISION_DESCRIPTOR.modelId,
} as const;
