import { describe, expect, it } from "vitest";
import { PROBE_VERSION, type ProbeContext, type ProbeRecord } from "./deviceProbe";
import { createInitialStatus, transitionOfflineModel } from "./offlineModelManager";
import type { OfflineAssetPin } from "./offlineModelManager";
import {
  canShowAuto,
  canShowGpu,
  canShowNeedle,
  canShowOffline,
} from "./uiGates";

const CONTEXT: ProbeContext = {
  modelRev: "rev-a",
  probeVersion: PROBE_VERSION,
  corpusVersion: "ws7-v1",
};

function probe(overrides: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    socModel: "Test SoC",
    gpuInfo: "Test GPU",
    ramMb: 8192,
    osVersion: "Android 15",
    backend: "cpu",
    ttftMs: 200,
    tokensPerSec: 20,
    corpusVersion: CONTEXT.corpusVersion,
    probeVersion: CONTEXT.probeVersion,
    modelRev: CONTEXT.modelRev,
    correctnessPass: true,
    ...overrides,
  };
}

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

describe("uiGates canShowAuto", () => {
  it("defaults to false without evidence", () => {
    expect(canShowAuto([], CONTEXT)).toBe(false);
    expect(canShowAuto(undefined, CONTEXT)).toBe(false);
    expect(canShowAuto(null, CONTEXT)).toBe(false);
    expect(canShowAuto([probe()], undefined)).toBe(false);
    expect(canShowAuto([probe()], null)).toBe(false);
  });

  it("is true only with a fresh passing probe", () => {
    expect(canShowAuto([probe()], CONTEXT)).toBe(true);
  });

  it("stays false for stale or failing probes", () => {
    expect(canShowAuto([probe({ modelRev: "rev-old" })], CONTEXT)).toBe(false);
    expect(canShowAuto([probe({ correctnessPass: false })], CONTEXT)).toBe(false);
    expect(
      canShowAuto([probe({ tokensPerSec: Number.NaN })], CONTEXT),
    ).toBe(false);
  });
});

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

describe("uiGates canShowGpu", () => {
  it("defaults to false without evidence", () => {
    expect(canShowGpu([], CONTEXT)).toBe(false);
    expect(canShowGpu(undefined, CONTEXT)).toBe(false);
    expect(canShowGpu(null, CONTEXT)).toBe(false);
    expect(canShowGpu([probe({ backend: "gpu" })], undefined)).toBe(false);
  });

  it("is true only when a fresh passing GPU probe is the measured winner", () => {
    expect(
      canShowGpu(
        [
          probe({ backend: "cpu", tokensPerSec: 20, ttftMs: 200 }),
          probe({ backend: "gpu", tokensPerSec: 42, ttftMs: 120 }),
        ],
        CONTEXT,
      ),
    ).toBe(true);
  });

  it("stays false when the CPU probe measures faster (no GPU-faster claims)", () => {
    expect(
      canShowGpu(
        [
          probe({ backend: "cpu", tokensPerSec: 60, ttftMs: 100 }),
          probe({ backend: "gpu", tokensPerSec: 42, ttftMs: 120 }),
        ],
        CONTEXT,
      ),
    ).toBe(false);
    // The auto gate still shows: measurement exists, GPU just did not win.
    expect(
      canShowAuto(
        [
          probe({ backend: "cpu", tokensPerSec: 60, ttftMs: 100 }),
          probe({ backend: "gpu", tokensPerSec: 42, ttftMs: 120 }),
        ],
        CONTEXT,
      ),
    ).toBe(true);
  });

  it("stays false for stale or failing GPU probes", () => {
    expect(
      canShowGpu([probe({ backend: "gpu", modelRev: "rev-old" })], CONTEXT),
    ).toBe(false);
    expect(
      canShowGpu(
        [probe({ backend: "gpu", correctnessPass: false, tokensPerSec: 999 })],
        CONTEXT,
      ),
    ).toBe(false);
  });
});
