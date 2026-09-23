// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { friendlyVlmMessage, isVlmCancellation } from "./vlmErrors";

describe("friendlyVlmMessage (central VLM error map)", () => {
  it("maps known native codes to plain language", () => {
    expect(friendlyVlmMessage("GPU_UNAVAILABLE_ON_CURRENT_RUNTIME")).toMatch(
      /cpu compatibility/i,
    );
    expect(friendlyVlmMessage(new Error("HASH_MISMATCH"))).toMatch(
      /didn't match|did not match/i,
    );
    expect(friendlyVlmMessage("MODEL_MISSING")).toMatch(/missing/i);
    expect(friendlyVlmMessage("INPUT_ERROR")).toMatch(/couldn't be read/i);
  });

  it("maps unstructured output to the manual-entry fallback", () => {
    const unstructured = Object.assign(new Error("UNSTRUCTURED_OUTPUT"), {
      name: "VlmUnstructuredOutputError",
    });
    expect(friendlyVlmMessage(unstructured)).toMatch(
      /fill the details manually/i,
    );
  });

  it("never leaks raw READY_GPU, AUTO, or underscored codes", () => {
    for (const raw of [
      "READY_GPU",
      "AUTO",
      "GPU_UNAVAILABLE_ON_CURRENT_RUNTIME",
      "MODEL_RUNTIME_ERROR",
      "DOWNLOAD_FAILED",
    ]) {
      const message = friendlyVlmMessage(new Error(raw));
      expect(message).not.toContain("READY_GPU");
      expect(message).not.toContain("AUTO");
      expect(message).not.toContain(raw);
      expect(message).not.toMatch(/_/);
    }
  });

  it("falls back to a generic message instead of echoing unknown codes", () => {
    const message = friendlyVlmMessage("SOME_FUTURE_NATIVE_CODE_XYZ");
    expect(message).toMatch(/something went wrong/i);
    expect(message).not.toContain("SOME_FUTURE_NATIVE_CODE_XYZ");
  });

  it("detects cancellation quietly", () => {
    expect(isVlmCancellation({ code: "CANCELLED" })).toBe(true);
    expect(isVlmCancellation(new Error("CANCELLED"))).toBe(true);
    expect(isVlmCancellation(new Error("User cancelled"))).toBe(true);
    expect(isVlmCancellation(new Error("boom"))).toBe(false);
  });
});
