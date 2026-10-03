import { describe, expect, it } from "vitest";
import { FAULT_MODES, PROPOSED_MODE_ERROR_MAP } from "./FakeAiProvider";
import { SCENARIO_MATRIX, scenarioFor } from "./faultScenarios";

describe("fault scenario matrix", () => {
  it("covers all twenty-one required scenarios", () => {
    expect(SCENARIO_MATRIX.map((s) => s.id).sort()).toEqual(
      [
        "accelerator-unavailable-cpu-fallback",
        "disk-full-free-space",
        "download-http-drop-resume",
        "download-integrity-mismatch-reinstall",
        "help-loop-recovery",
        "help-timeout-switch-model",
        "inference-concurrency-conflict-retry",
        "invalid-utf8-output-rejected",
        "model-corrupt-reinstall",
        "model-deleted-while-sheet-open",
        "model-switch-releases-runtime",
        "navigate-away-mid-generation",
        "oom-during-generation",
        "photo-invalid",
        "photo-valid",
        "process-death-twice-fail-closed",
        "rejected-request-offline-or-unsafe",
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

  it("gives every WS-F scenario an expected error class and UI affordance", () => {
    const wsfIds = [
      "download-http-drop-resume",
      "download-integrity-mismatch-reinstall",
      "disk-full-free-space",
      "accelerator-unavailable-cpu-fallback",
      "invalid-utf8-output-rejected",
      "process-death-twice-fail-closed",
      "inference-concurrency-conflict-retry",
      "rejected-request-offline-or-unsafe",
    ];
    expect(wsfIds).toHaveLength(8);
    for (const id of wsfIds) {
      const scenario = scenarioFor(id);
      expect(scenario).toBeDefined();
      expect(scenario!.expectedError).not.toBeUndefined();
      expect(scenario!.expectedUi.length).toBeGreaterThan(0);
      expect(scenario!.notes.length).toBeGreaterThan(0);
    }
    expect(scenarioFor("download-http-drop-resume")?.expectedError).toBe("MODEL_UNAVAILABLE");
    expect(scenarioFor("download-integrity-mismatch-reinstall")?.expectedError).toBe("MODEL_CORRUPT");
    expect(scenarioFor("disk-full-free-space")?.expectedError).toBe("LOW_MEMORY");
    expect(scenarioFor("accelerator-unavailable-cpu-fallback")?.expectedError).toBe("RUNTIME_ERROR");
    expect(scenarioFor("invalid-utf8-output-rejected")?.expectedError).toBe("INVALID_OUTPUT");
    expect(scenarioFor("process-death-twice-fail-closed")?.expectedError).toBe("RUNTIME_ERROR");
    expect(scenarioFor("process-death-twice-fail-closed")?.modes).toEqual(["PROCESS_DEATH", "PROCESS_DEATH"]);
    expect(scenarioFor("inference-concurrency-conflict-retry")?.expectedError).toBe("RUNTIME_ERROR");
    expect(scenarioFor("rejected-request-offline-or-unsafe")?.expectedError).toBe("UNSUPPORTED_REQUEST");
  });

  it("covers every WS-F fault mode in at least one scenario", () => {
    const covered = new Set(scenarioFor("download-http-drop-resume")!.modes);
    for (const scenario of SCENARIO_MATRIX) {
      for (const mode of scenario.modes) covered.add(mode);
    }
    for (const mode of [
      "HTTP_DROP",
      "WRONG_CONTENT_RANGE",
      "HASH_MISMATCH",
      "DISK_FULL",
      "GPU_INIT_ERROR",
      "NPU_ABSENT",
      "INVALID_UTF8",
      "PROCESS_DEATH",
      "TWO_VLM_RACE",
      "MODEL_UPDATE_DURING_INFERENCE",
      "CLOUD_OFFLINE",
      "PATH_TRAVERSAL",
    ] as const) {
      expect(covered.has(mode)).toBe(true);
      expect(PROPOSED_MODE_ERROR_MAP[mode]).not.toBeUndefined();
    }
  });
});
