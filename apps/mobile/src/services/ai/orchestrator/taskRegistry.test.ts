import { describe, expect, it } from "vitest";
import {
  getTaskSpec,
  isTaskId,
  listTaskSpecs,
  TASK_IDS,
} from "./taskRegistry";

describe("taskRegistry", () => {
  it("registers exactly the 10 WS-A tasks", () => {
    expect(TASK_IDS).toEqual([
      "classify-intent",
      "extract-report-fields",
      "answer-help",
      "extract-search-filters",
      "analyze-image",
      "route-intent",
      "embed-texts",
      "ground-objects",
      "classify-category",
      "summarize-local-context",
    ]);
    expect(listTaskSpecs()).toHaveLength(10);
  });

  it("exposes a full AiTaskSpec for every task", () => {
    for (const taskId of TASK_IDS) {
      const spec = getTaskSpec(taskId);
      expect(spec).toBeDefined();
      expect(spec?.taskId).toBe(taskId);
      expect(typeof spec?.maxBytes).toBe("number");
      expect(typeof spec?.maxImages).toBe("number");
      expect(typeof spec?.timeoutMs).toBe("number");
      expect(typeof spec?.needsConsent).toBe("boolean");
      expect(typeof spec?.schema).toBe("string");
      expect((spec?.schema ?? "").trim().length).toBeGreaterThan(0);
      expect(Array.isArray(spec?.runtimes)).toBe(true);
      expect(spec!.runtimes.length).toBeGreaterThan(0);
      expect(spec!.maxBytes).toBeGreaterThan(0);
      expect(spec!.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("keeps image tasks bounded to image runtimes and text tasks imageless", () => {
    expect(getTaskSpec("analyze-image")?.maxImages).toBe(1);
    expect(getTaskSpec("ground-objects")?.maxImages).toBe(1);
    expect(getTaskSpec("classify-intent")?.maxImages).toBe(0);
    expect(getTaskSpec("embed-texts")?.maxImages).toBe(0);
  });

  it("returns undefined for an unknown task id", () => {
    expect(getTaskSpec("teleport")).toBeUndefined();
    expect(isTaskId("teleport")).toBe(false);
    expect(isTaskId("classify-intent")).toBe(true);
    expect(isTaskId(42)).toBe(false);
  });
});
