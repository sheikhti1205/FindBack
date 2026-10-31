import { describe, expect, it } from "vitest";
import { createInitialStatus, transitionOfflineModel } from "./offlineModelManager";
import type { OfflineAssetPin } from "./offlineModelManager";
import { canShowNeedle, canShowOffline } from "./uiGates";

const PIN: OfflineAssetPin = {
  modelId: "test-model",
  sha256: "a".repeat(64),
  downloadBytes: 1000,
  minFreeRamMb: 512,
};

function installedVerifiedStatus() {
  let status = createInitialStatus(PIN);
  status = transitionOfflineModel(status, {
    type: "QUEUE_DOWNLOAD",
    userInitiated: true,
  });
  status = transitionOfflineModel(status, { type: "START" });
  status = transitionOfflineModel(status, { type: "VERIFY_START" });
  // VERIFY_OK with the exact pin transitions to installed + verified.
  return transitionOfflineModel(status, {
    type: "VERIFY_OK",
    actualSha256: PIN.sha256,
  });
}

describe("uiGates canShowOffline", () => {
  it("defaults to false without evidence", () => {
    expect(canShowOffline(undefined)).toBe(false);
    expect(canShowOffline(null)).toBe(false);
    expect(canShowOffline(createInitialStatus(PIN))).toBe(false);
  });

  it("is true only for installed + verified status", () => {
    expect(canShowOffline(installedVerifiedStatus())).toBe(true);
  });

  it("stays false for unverified or in-progress states", () => {
    const failed = transitionOfflineModel(
      transitionOfflineModel(
        transitionOfflineModel(
          transitionOfflineModel(createInitialStatus(PIN), {
            type: "QUEUE_DOWNLOAD",
            userInitiated: true,
          }),
          { type: "START" },
        ),
        { type: "VERIFY_START" },
      ),
      { type: "VERIFY_FAIL", reason: "hash mismatch" },
    );
    expect(canShowOffline(failed)).toBe(false);
    const queued = transitionOfflineModel(createInitialStatus(PIN), {
      type: "QUEUE_DOWNLOAD",
      userInitiated: true,
    });
    expect(canShowOffline(queued)).toBe(false);
  });
});

describe("uiGates canShowNeedle", () => {
  it("defaults to false without evidence", () => {
    expect(canShowNeedle(undefined)).toBe(false);
    expect(canShowNeedle(null)).toBe(false);
    expect(
      canShowNeedle({ measured: false, correctnessPass: false, fresh: false }),
    ).toBe(false);
  });

  it("is true only with measured + passing + fresh evidence", () => {
    expect(
      canShowNeedle({ measured: true, correctnessPass: true, fresh: true }),
    ).toBe(true);
  });

  it("stays false when any flag is missing", () => {
    expect(
      canShowNeedle({ measured: true, correctnessPass: false, fresh: true }),
    ).toBe(false);
    expect(
      canShowNeedle({ measured: true, correctnessPass: true, fresh: false }),
    ).toBe(false);
    expect(
      canShowNeedle({ measured: false, correctnessPass: true, fresh: true }),
    ).toBe(false);
  });
});
