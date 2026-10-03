import { describe, expect, it } from "vitest";
import { mustProfile } from "../ops/testSupport";
import {
  checkPromotionGates,
  PROMOTION_GATES,
  type PromotionEvidence,
} from "./promotionPolicy";

function allTrue(): PromotionEvidence {
  return Object.fromEntries(PROMOTION_GATES.map((gate) => [gate, true]));
}

describe("checkPromotionGates 12-gate checklist", () => {
  it("defaults deny: all-false evidence is not promotable with 12 reasons", () => {
    const decision = checkPromotionGates(mustProfile("qwen3-0.6b-dynamic-int4"), {});
    expect(decision.promotable).toBe(false);
    expect(decision.gates).toHaveLength(12);
    expect(decision.gates.map((gate) => gate.id)).toEqual([...PROMOTION_GATES]);
    expect(decision.gates.every((gate) => gate.passed === false)).toBe(true);
    expect(decision.reasons).toHaveLength(12);
    for (const gate of decision.gates) {
      expect(gate.reason.length).toBeGreaterThan(0);
    }
  });

  it("promotes a permissive profile only when all 12 gates pass", () => {
    const decision = checkPromotionGates(mustProfile("qwen3-0.6b-dynamic-int4"), allTrue());
    expect(decision.promotable).toBe(true);
    expect(decision.reasons).toHaveLength(0);
    expect(decision.gates.every((gate) => gate.passed)).toBe(true);
  });

  it("fails closed on a single missing gate with a targeted reason", () => {
    const evidence = allTrue();
    delete evidence["security-review"];
    const decision = checkPromotionGates(mustProfile("qwen3-0.6b-dynamic-int4"), evidence);
    expect(decision.promotable).toBe(false);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toContain("security-review");
  });

  it("never promotes catalogOnly (LFM) profiles even with all-true evidence", () => {
    for (const id of ["lfm2.5-1.2b-q4_0", "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb"]) {
      const decision = checkPromotionGates(mustProfile(id), allTrue());
      expect(decision.promotable).toBe(false);
      const licenseGate = decision.gates.find((gate) => gate.id === "license-ok");
      expect(licenseGate?.passed).toBe(false);
      expect(licenseGate?.reason).toContain("catalogOnly");
    }
  });
});
