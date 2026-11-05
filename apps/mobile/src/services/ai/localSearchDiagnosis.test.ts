import { describe, expect, it } from "vitest";
import {
  downloadProblemStage,
  isLocalSearchAbort,
  localSearchFailureOf,
  type LocalSearchStage,
} from "./localSearchDiagnosis";

describe("local search stage receipts", () => {
  it.each([
    ["NO_RUNTIME", "helper"],
    ["MODEL_NOT_READY", "helper"],
    ["DRIVER_UNAVAILABLE", "plugin"],
    ["INSUFFICIENT_STORAGE", "storage"],
    ["BAD_SOURCE", "source"],
    ["HTTP_404", "source"],
    ["HTTP_503", "source"],
    ["OFFSET_MISMATCH", "source"],
    ["REDIRECT_NON_HTTPS", "source"],
    ["TOO_MANY_REDIRECTS", "source"],
    ["CHECKSUM_MISMATCH", "hash"],
    ["SIZE_MISMATCH", "hash"],
    ["PROMOTE_FAILED", "promotion"],
    ["ALREADY_RUNNING", "busy"],
    ["RUNTIME_ERROR", "runtime"],
    ["INVALID_OUTPUT", "output"],
    ["LOCAL_TASK_INVALID", "output"],
  ] as const)("maps %s to the %s boundary", (code, stage) => {
    expect(localSearchFailureOf({ code })).toEqual({ stage, code });
    // The route's denial reason is the same vocabulary at a different depth.
    expect(localSearchFailureOf({ denialReason: code, message: "unrelated" })).toEqual({ stage, code });
  });

  it("keeps the ai error class when no denial reason exists", () => {
    expect(localSearchFailureOf({ errorClass: "INVALID_OUTPUT", diagnostic: "bad json" }))
      .toEqual({ stage: "output", code: "INVALID_OUTPUT" });
  });

  it("classifies un-coded service throws by their consumer-safe message", () => {
    expect(localSearchFailureOf(new Error("On-device AI requires the Android app.")).stage).toBe("plugin");
    expect(localSearchFailureOf(new Error("Unavailable on this device.")).stage).toBe("plugin");
    expect(localSearchFailureOf(new Error("Model is not installed and verified")).stage).toBe("helper");
    expect(localSearchFailureOf(new Error("On-device runtime is busy")).stage).toBe("busy");
    expect(localSearchFailureOf(new Error("not enough free storage for this download")).stage).toBe("storage");
    expect(localSearchFailureOf(new Error("Model storage is unavailable on this build")).stage).toBe("storage");
    expect(localSearchFailureOf(new Error("verified bytes could not be promoted")).stage).toBe("promotion");
    expect(localSearchFailureOf(new Error("staged bytes failed pin verification")).stage).toBe("hash");
    expect(localSearchFailureOf(new Error("HTTP redirect refused")).stage).toBe("source");
    expect(localSearchFailureOf(new Error("Needle did not produce a confident record")).stage).toBe("output");
  });

  it("never claims more than a stage and an allowlisted token", () => {
    const receipt = localSearchFailureOf(new Error("private /data/user/0/com.findback.app/models needle-cact"));
    expect(Object.keys(receipt).sort()).toEqual(["code", "stage"]);
    expect(receipt).toEqual({ stage: "runtime", code: "UNKNOWN" });
    expect(JSON.stringify(receipt)).not.toMatch(/private|com\.findback|needle-cact/);
  });

  it("recognises cancellation instead of turning it into a failure receipt", () => {
    expect(isLocalSearchAbort({ name: "AbortError" })).toBe(true);
    expect(isLocalSearchAbort({ denialReason: "CANCELLED" })).toBe(true);
    expect(isLocalSearchAbort({ code: "ABORTED" })).toBe(true);
    expect(isLocalSearchAbort({ denialReason: "RUNTIME_ERROR" })).toBe(false);
    expect(isLocalSearchAbort(new Error("cancelled"))).toBe(false);
  });

  it("maps download problem text back to the same vocabulary", () => {
    expect(downloadProblemStage("Download stopped (HTTP_503).")).toBe("source");
    expect(downloadProblemStage("Download stopped (CHECKSUM_MISMATCH).")).toBe("hash");
    expect(downloadProblemStage("Download did not match the exact expected size.")).toBe("hash");
    expect(downloadProblemStage("Download stopped (PROMOTE_FAILED).")).toBe("promotion");
    expect(downloadProblemStage("not enough free storage for this download")).toBe("storage");
    expect(downloadProblemStage("Unavailable on this device.")).toBe("plugin");
    // Dedicated states keep their own handling and are not re-labelled here.
    expect(downloadProblemStage("removal failed")).toBeNull();
    expect(downloadProblemStage("")).toBeNull();
    expect(downloadProblemStage(null)).toBeNull();
  });

  it("covers every stage with a consumer sentence", async () => {
    const { LOCAL_SEARCH_FAILURE_NOTE } = await import("../../screens/nlHelperCopy");
    const stages: LocalSearchStage[] = [
      "helper", "plugin", "storage", "source", "hash", "promotion", "runtime", "output", "busy",
    ];
    for (const stage of stages) {
      expect(LOCAL_SEARCH_FAILURE_NOTE[stage].length).toBeGreaterThan(0);
      // No failed attempt may borrow the "the engine ran and found nothing"
      // sentence; that is the defect this receipt exists to prevent.
      expect(LOCAL_SEARCH_FAILURE_NOTE[stage]).not.toMatch(/no extra filters|nothing confident/i);
    }
  });
});
