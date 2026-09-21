import { describe, expect, it } from "vitest";
import {
  GuardError,
  RECOVERY_COPY,
  errorClassForMode,
  guardErrorForMode,
  isRetryableClass,
} from "./errors";
import { FAULT_MODES, PROPOSED_MODE_ERROR_MAP } from "./testing/FakeAiProvider";

describe("recovery copy (frozen wording)", () => {
  it("loop copy uses the exact stuck-generating string with Retry/Switch/Manual", () => {
    expect(RECOVERY_COPY.LOOP_DETECTED.message).toContain("This model got stuck generating a response.");
    expect(RECOVERY_COPY.LOOP_DETECTED.actions).toEqual(["Retry", "Use another model", "Continue manually"]);
  });

  it("low-memory copy uses the exact free-memory string with smaller-model choice", () => {
    expect(RECOVERY_COPY.LOW_MEMORY.message).toContain("There isn't enough free memory...");
    expect(RECOVERY_COPY.LOW_MEMORY.actions).toEqual(["Choose a smaller model", "Continue manually"]);
  });

  it("invalid copy uses the exact usable-answer string", () => {
    expect(RECOVERY_COPY.INVALID_OUTPUT.message).toContain("couldn't produce a usable answer");
    expect(RECOVERY_COPY.INVALID_OUTPUT.actions).toEqual(["Retry", "Use another model", "Continue manually"]);
  });

  it("corrupt offers Repair/Delete model", () => {
    expect(RECOVERY_COPY.MODEL_CORRUPT.actions).toEqual(["Repair model", "Delete model"]);
  });

  it("cancelled is quiet: no error toast actions", () => {
    expect(RECOVERY_COPY.CANCELLED.actions).toEqual([]);
  });
});

describe("retry policy", () => {
  it("retries only loop/timeout/invalid/runtime", () => {
    expect(isRetryableClass("LOOP_DETECTED")).toBe(true);
    expect(isRetryableClass("TIMEOUT")).toBe(true);
    expect(isRetryableClass("INVALID_OUTPUT")).toBe(true);
    expect(isRetryableClass("RUNTIME_ERROR")).toBe(true);
    for (const errorClass of [
      "LOW_MEMORY",
      "UNSUPPORTED_REQUEST",
      "UNSUPPORTED_ACTION",
      "MODEL_UNAVAILABLE",
      "MODEL_CORRUPT",
      "CANCELLED",
    ] as const) {
      expect(isRetryableClass(errorClass)).toBe(false);
    }
  });
});

describe("frozen mode mapping alignment", () => {
  it("matches PROPOSED_MODE_ERROR_MAP for all 19 modes", () => {
    expect(FAULT_MODES).toHaveLength(19);
    for (const mode of FAULT_MODES) {
      expect(errorClassForMode(mode)).toBe(PROPOSED_MODE_ERROR_MAP[mode]);
    }
  });

  it("preserves OOM_RUNTIME vs PRECHECK_INSUFFICIENT_MEMORY diagnostics", () => {
    const oom = guardErrorForMode("OOM");
    const low = guardErrorForMode("LOW_MEMORY");
    expect(oom).toMatchObject({ errorClass: "LOW_MEMORY", diagnosticCode: "OOM_RUNTIME" });
    expect(low).toMatchObject({ errorClass: "LOW_MEMORY", diagnosticCode: "PRECHECK_INSUFFICIENT_MEMORY" });
    expect(oom).toBeInstanceOf(GuardError);
    expect(oom?.retryable).toBe(false);
  });

  it("returns null for success modes (GOOD/SLOW/FENCED/PROSE)", () => {
    expect(guardErrorForMode("GOOD")).toBeNull();
    expect(guardErrorForMode("SLOW")).toBeNull();
    expect(guardErrorForMode("FENCED_JSON")).toBeNull();
    expect(guardErrorForMode("PROSE_PLUS_JSON")).toBeNull();
  });
});
