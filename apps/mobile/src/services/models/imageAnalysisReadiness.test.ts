import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVlmBridge } from "../vlmPlugin";
import { getCandidateHost } from "./candidateHost";
import {
  deriveImageAnalysisReadiness,
  readImageAnalysisReadiness,
  readinessFromImageState,
} from "./imageAnalysisReadiness";

vi.mock("../vlmPlugin", () => ({ getVlmBridge: vi.fn() }));
vi.mock("./candidateHost", () => ({ getCandidateHost: vi.fn() }));

const getVlmBridgeMock = vi.mocked(getVlmBridge);
const getCandidateHostMock = vi.mocked(getCandidateHost);

beforeEach(() => {
  vi.clearAllMocks();
  getCandidateHostMock.mockReturnValue(null);
});

describe("deriveImageAnalysisReadiness (frozen contract)", () => {
  it("reports CHECKING while the bridge has not settled", () => {
    expect(
      deriveImageAnalysisReadiness({ checking: true, state: "READY_GPU" }),
    ).toEqual({ available: false, reason: "CHECKING" });
    expect(readinessFromImageState(null, true)).toEqual({
      available: false,
      reason: "CHECKING",
    });
  });

  it("reports NO_MODEL when no image model is installed", () => {
    expect(
      deriveImageAnalysisReadiness({ checking: false, state: "NOT_INSTALLED" }),
    ).toEqual({ available: false, reason: "NO_MODEL" });
    expect(readinessFromImageState(null, false)).toEqual({
      available: false,
      reason: "NO_MODEL",
    });
  });

  it("reports READY only after GPU verification", () => {
    expect(readinessFromImageState("READY_GPU", false)).toEqual({
      available: true,
      reason: "READY",
    });
  });

  it("reports VERIFY_REQUIRED for installed-but-unverified image states", () => {
    expect(readinessFromImageState("INSTALLED_UNVERIFIED", false)).toEqual({
      available: false,
      reason: "VERIFY_REQUIRED",
    });
  });

  it("reports UNAVAILABLE for failed image states, never READY", () => {
    for (const state of [
      "GPU_UNAVAILABLE",
      "CORRUPT",
      "RUNTIME_ERROR",
      "DOWNLOAD_FAILED",
    ] as const) {
      const readiness = readinessFromImageState(state, false);
      expect(readiness.available).toBe(false);
      expect(readiness.reason).toBe("UNAVAILABLE");
    }
  });

  it("never exposes native enums in the frozen shape", () => {
    const readiness = readinessFromImageState("READY_GPU", false);
    expect(Object.keys(readiness).sort()).toEqual(["available", "reason"]);
  });

  it("reports UNAVAILABLE when the native readiness check fails", async () => {
    getVlmBridgeMock.mockReturnValue({
      getModelStates: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
    } as never);

    await expect(readImageAnalysisReadiness()).resolves.toEqual({
      available: false,
      reason: "UNAVAILABLE",
    });
  });

  it("reports READY when a verified vision candidate is the active entry", async () => {
    getVlmBridgeMock.mockReturnValue({
      getModelStates: vi.fn().mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]),
    } as never);
    getCandidateHostMock.mockReturnValue({
      getActive: vi.fn().mockResolvedValue("lfm2.5-vl-450m"),
    } as never);

    await expect(readImageAnalysisReadiness()).resolves.toEqual({
      available: true,
      reason: "READY",
    });
  });

  it("still reports NO_MODEL when no dedicated or candidate image model is ready", async () => {
    getVlmBridgeMock.mockReturnValue({
      getModelStates: vi.fn().mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]),
    } as never);
    getCandidateHostMock.mockReturnValue({
      getActive: vi.fn().mockResolvedValue(null),
    } as never);

    await expect(readImageAnalysisReadiness()).resolves.toEqual({
      available: false,
      reason: "NO_MODEL",
    });
  });
});
