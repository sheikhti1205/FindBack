import { describe, expect, it } from "vitest";
import { FAULT_MODES } from "./FakeAiProvider";
import { SCENARIO_MATRIX, scenarioFor } from "./faultScenarios";

describe("fault scenario matrix", () => {
  it("covers all thirteen required scenarios", () => {
    expect(SCENARIO_MATRIX.map((s) => s.id).sort()).toEqual(
      [
        "help-loop-recovery",
        "help-timeout-switch-model",
        "model-corrupt-reinstall",
        "model-deleted-while-sheet-open",
        "model-switch-releases-runtime",
        "navigate-away-mid-generation",
        "oom-during-generation",
        "photo-invalid",
        "photo-valid",
        "report-malformed-extraction",
        "report-unknown-action-rejected",
        "search-ambiguous-place",
        "user-cancel",
      ].sort(),
    );
  });

  it("references only real fault modes and looks up by id", () => {
    for (const scenario of SCENARIO_MATRIX) {
      expect(scenario.modes.length).toBeGreaterThan(0);
      for (const mode of scenario.modes) {
        expect(FAULT_MODES).toContain(mode);
      }
      expect(scenario.expectedUi.length).toBeGreaterThan(0);
    }
    expect(scenarioFor("help-loop-recovery")?.expectedError).toBe("LOOP_DETECTED");
    expect(scenarioFor("user-cancel")?.expectedError).toBe("CANCELLED");
    expect(scenarioFor("photo-valid")?.expectedError).toBeNull();
    expect(scenarioFor("model-corrupt-reinstall")?.expectedError).toBe("MODEL_CORRUPT");
    expect(scenarioFor("search-ambiguous-place")?.expectedError).toBeNull();
    expect(scenarioFor("search-ambiguous-place")?.expectedAssistantState).toBe("ASK_USER");
    expect(scenarioFor("oom-during-generation")?.expectedError).toBe("LOW_MEMORY");
    expect(scenarioFor("no-such-scenario")).toBeUndefined();
  });
});
