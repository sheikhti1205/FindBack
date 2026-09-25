import { describe, expect, it } from "vitest";
import {
  COMPACTION_TRIGGER_HIGH,
  COMPACTION_TRIGGER_LOW,
  computeContextBudget,
  estimateImageAllowance,
  replanForModelSwitch,
  resolveOutputCap,
} from "./contextBudget";

describe("computeContextBudget preflight formula", () => {
  it("subtracts every explicit term for a verified 200k window", () => {
    const budget = computeContextBudget({
      verifiedContextWindow: 200_000,
      reservedOutput: 4_096,
      imageAllowance: 10_000,
      protocolOverhead: 1_000,
      safetyMargin: 2_000,
      estimatedInput: 50_000,
    });
    expect(budget.state).toBe("known");
    expect(budget.usableInput).toBe(200_000 - 4_096 - 10_000 - 1_000 - 2_000);
    expect(budget.effectiveWindow).toBe(200_000);
    expect(budget.shouldCompact).toBe(false);
  });

  it("keeps unknown terms unknown instead of zeroing them", () => {
    const unknownWindow = computeContextBudget({
      reservedOutput: 1_000,
      imageAllowance: 500,
      protocolOverhead: 200,
      safetyMargin: 200,
      estimatedInput: 10,
    });
    expect(unknownWindow.state).toBe("unknown");
    expect(unknownWindow.usableInput).toBeUndefined();
    expect(unknownWindow.unknownReasons).toContain("verifiedContextWindow");
    // Unknown window must not silently become a zero budget.
    expect(unknownWindow.unknownReasons.length).toBeGreaterThan(0);

    const unknownImages = computeContextBudget({
      verifiedContextWindow: 64_000,
      reservedOutput: 1_000,
      protocolOverhead: 200,
      safetyMargin: 200,
      estimatedInput: 10,
    });
    expect(unknownImages.state).toBe("unknown");
    expect(unknownImages.usableInput).toBeUndefined();
    expect(unknownImages.unknownReasons).toContain("imageAllowance");
  });

  it("treats a 32k window honestly against the same prompt a 200k window accepts", () => {
    const shared = {
      reservedOutput: 4_096,
      imageAllowance: 5_000,
      protocolOverhead: 1_000,
      safetyMargin: 2_000,
      estimatedInput: 25_000,
    };
    const large = computeContextBudget({ ...shared, verifiedContextWindow: 200_000 });
    const small = computeContextBudget({ ...shared, verifiedContextWindow: 32_000 });
    expect(large.state).toBe("known");
    expect(small.state).toBe("known");
    expect(small.usableInput).toBeLessThan(large.usableInput!);
    // 25k of ~19.9k usable on the small route compacts; on 200k it does not.
    expect(small.shouldCompact).toBe(true);
    expect(large.shouldCompact).toBe(false);
  });

  it("derives the compaction trigger from a 60-70% fraction, not a fixed constant", () => {
    expect(COMPACTION_TRIGGER_LOW).toBe(0.6);
    expect(COMPACTION_TRIGGER_HIGH).toBe(0.7);
    const terms = {
      reservedOutput: 2_000,
      imageAllowance: 0,
      protocolOverhead: 500,
      safetyMargin: 500,
    };
    // Illustrative 200k window: ~120k-140k trigger band falls out of the fraction.
    const twoHundredK = computeContextBudget({ ...terms, verifiedContextWindow: 200_000, estimatedInput: 120_000 });
    expect(twoHundredK.compactionThreshold).toBeCloseTo(0.6 * twoHundredK.usableInput!, 6);
    // The same fraction on a 32k window triggers far below any 120k constant.
    const thirtyTwoK = computeContextBudget({ ...terms, verifiedContextWindow: 32_000, estimatedInput: 20_000 });
    expect(thirtyTwoK.compactionThreshold).toBeLessThan(30_000);
    expect(thirtyTwoK.shouldCompact).toBe(true);
    const below = computeContextBudget({ ...terms, verifiedContextWindow: 32_000, estimatedInput: 5_000 });
    expect(below.shouldCompact).toBe(false);
  });

  it("never treats file bytes as image tokens", () => {
    const imageCount = 10;
    const allowance = estimateImageAllowance({ imageCount, tokensPerImage: 1_000 });
    expect(allowance).toBe(10_000);
    const smallFile = computeContextBudget({
      verifiedContextWindow: 64_000,
      reservedOutput: 2_000,
      imageAllowance: allowance,
      protocolOverhead: 500,
      safetyMargin: 500,
      estimatedInput: 5_000,
      fileBytes: 200_000,
    });
    const hugeFile = computeContextBudget({
      verifiedContextWindow: 64_000,
      reservedOutput: 2_000,
      imageAllowance: allowance,
      protocolOverhead: 500,
      safetyMargin: 500,
      estimatedInput: 5_000,
      fileBytes: 16_000_000,
    });
    expect(smallFile.usableInput).toBe(hugeFile.usableInput);
  });

  it("keeps a 10-image turn fully selected and reports the route fit", () => {
    const allowance = estimateImageAllowance({ imageCount: 10, tokensPerImage: 1_000 });
    const budget = computeContextBudget({
      verifiedContextWindow: 32_000,
      reservedOutput: 2_000,
      imageAllowance: allowance,
      protocolOverhead: 500,
      safetyMargin: 500,
      estimatedInput: 25_000,
      imageCount: 10,
    });
    expect(budget.state).toBe("known");
    expect(budget.imageCount).toBe(10);
    // Selections are never silently dropped: the budget flags compaction/routing instead.
    expect(budget.shouldCompact).toBe(true);
    expect(budget.fitsInput).toBe(false);
  });

  it("keeps the output cap separate from the window", () => {
    expect(resolveOutputCap({ maxOutputTokens: 4_096 })).toBe(4_096);
    expect(resolveOutputCap({})).toBe(600);
    const budget = computeContextBudget({
      verifiedContextWindow: 64_000,
      reservedOutput: 4_096,
      imageAllowance: 0,
      protocolOverhead: 500,
      safetyMargin: 500,
      estimatedInput: 1_000,
    });
    // The reservation is subtracted; the cap itself is not clamped to the window here.
    expect(budget.usableInput).toBe(64_000 - 4_096 - 0 - 500 - 500);
    expect(resolveOutputCap({ maxOutputTokens: 8_192 })).toBe(8_192);
  });

  it("replans before sending when the route falls back from 200k to 32k", () => {
    const before = computeContextBudget({
      verifiedContextWindow: 200_000,
      reservedOutput: 4_096,
      imageAllowance: 5_000,
      protocolOverhead: 1_000,
      safetyMargin: 2_000,
      estimatedInput: 100_000,
    });
    expect(before.shouldCompact).toBe(false);
    const after = replanForModelSwitch(before.input, 32_000);
    expect(after.effectiveWindow).toBe(32_000);
    expect(after.usableInput).toBeLessThan(before.usableInput!);
    // 100k estimated input cannot fit the smaller route: rebudget flags it pre-send.
    expect(after.shouldCompact).toBe(true);
    expect(after.fitsInput).toBe(false);
  });

  it("stays unknown through a model switch to an unverified window", () => {
    const before = computeContextBudget({
      verifiedContextWindow: 200_000,
      reservedOutput: 4_096,
      imageAllowance: 5_000,
      protocolOverhead: 1_000,
      safetyMargin: 2_000,
      estimatedInput: 1_000,
    });
    const after = replanForModelSwitch(before.input, undefined);
    expect(after.state).toBe("unknown");
    expect(after.usableInput).toBeUndefined();
  });
});
