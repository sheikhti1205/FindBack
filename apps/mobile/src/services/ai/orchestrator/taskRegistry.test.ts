import { describe, expect, it } from "vitest";
import {
  getTaskSpec,
  isTaskId,
  listTaskSpecs,
  TASK_IDS,
} from "./taskRegistry";

describe("taskRegistry", () => {
  it("registers exactly the retained local tool tasks", () => {
    // The retired local generative surface (prose answer/summarize, photo
    // analysis, object grounding) has no task here: those runtimes are gone,
    // so a task id for them could only ever end in NO_RUNTIME.
    expect(TASK_IDS).toEqual([
      "classify-intent",
      "extract-report-fields",
      "extract-search-filters",
      "route-intent",
      "embed-texts",
      "classify-category",
    ]);
    expect(listTaskSpecs()).toHaveLength(6);
  });

  it("exposes a full AiTaskSpec for every task", () => {
    for (const taskId of TASK_IDS) {
      const spec = getTaskSpec(taskId);
      expect(spec).toBeDefined();
      expect(spec?.taskId).toBe(taskId);
      expect(typeof spec?.maxBytes).toBe("number");
      expect(typeof spec?.maxImages).toBe("number");
      expect(typeof spec?.timeoutMs).toBe("number");
      expect(typeof spec?.consent.required).toBe("boolean");
      expect(typeof spec?.maxInputChars).toBe("number");
      expect(typeof spec?.maxOutputTokens).toBe("number");
      expect(typeof spec?.retryLimit).toBe("number");
      expect(spec?.privacy.tier).toBe("local-only");
      expect(typeof spec?.privacy.handlesImage).toBe("boolean");
      expect(typeof spec?.schema).toBe("string");
      expect((spec?.schema ?? "").trim().length).toBeGreaterThan(0);
      expect(Array.isArray(spec?.runtimes)).toBe(true);
      expect(spec!.runtimes.length).toBeGreaterThan(0);
      expect(spec!.maxBytes).toBeGreaterThan(0);
      expect(spec!.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("keeps every retained task text-only and imageless", () => {
    for (const taskId of TASK_IDS) {
      expect(getTaskSpec(taskId)?.maxImages).toBe(0);
      expect(getTaskSpec(taskId)?.privacy.handlesImage).toBe(false);
    }
  });

  it("returns undefined for an unknown task id", () => {
    expect(getTaskSpec("teleport")).toBeUndefined();
    expect(isTaskId("teleport")).toBe(false);
    expect(isTaskId("classify-intent")).toBe(true);
    expect(isTaskId(42)).toBe(false);
  });
});
