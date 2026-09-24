import { describe, expect, it } from "vitest";
import { actionOwnerFor, applyLiveState, compactDescriptors, deviceFitFor, importedToManagerModels, managerStatusFrom } from "./compactManager";

describe("compact six-model mapping", () => {
  it("exposes exactly six entries, Recommended 2 + Experimental 4, no Gemma", () => {
    const models = compactDescriptors();
    expect(models).toHaveLength(6);
    expect(models.filter((m) => m.category === "RECOMMENDED")).toHaveLength(2);
    expect(models.filter((m) => m.category === "EXPERIMENTAL")).toHaveLength(4);
    expect(models.filter((m) => m.category === "IMPORTED")).toHaveLength(0);
    expect(models.some((m) => /gemma/i.test(m.label))).toBe(false);
    expect(models.map((m) => m.entryId)).toEqual([
      "smolvlm2-500m-litert-int4",
      "qwen3-0.6b-litert-dynamic-int4",
      "qwen3-0.6b-litert-mixed-int4",
      "qwen3-0.6b-litert-int8",
      "lfm2.5-1.2b-instruct-litert-int4-gpu",
      "lfm2.5-vl-450m",
    ]);
  });

  it("maps native lifecycle strings honestly without inventing readiness", () => {
    expect(managerStatusFrom("NOT_INSTALLED")).toBe("NOT_INSTALLED");
    expect(managerStatusFrom("DOWNLOADING")).toBe("DOWNLOADING");
    expect(managerStatusFrom("READY_GPU")).toBe("READY");
    expect(managerStatusFrom("TEXT_READY")).toBe("READY");
    expect(managerStatusFrom("INSTALLED_UNVERIFIED")).toBe("INSTALLED_UNVERIFIED");
    expect(managerStatusFrom("GPU_UNAVAILABLE")).toBe("INCOMPATIBLE");
    expect(managerStatusFrom("UNPUBLISHED")).toBe("UNAVAILABLE");
  });

  it("maps failures and unknown states to error/failed states, never installed-unverified", () => {
    expect(managerStatusFrom("DOWNLOAD_FAILED")).toBe("FAILED");
    expect(managerStatusFrom("CORRUPT")).toBe("FAILED");
    expect(managerStatusFrom("INSUFFICIENT_STORAGE")).toBe("FAILED");
    expect(managerStatusFrom("MANIFEST_MISMATCH")).toBe("FAILED");
    expect(managerStatusFrom("REPAIR_NEEDED")).toBe("FAILED");
    expect(managerStatusFrom("PAUSED_ERROR")).toBe("ERROR");
    expect(managerStatusFrom("RUNTIME_ERROR")).toBe("ERROR");
    expect(managerStatusFrom("SOME_FUTURE_NATIVE_STATE")).toBe("ERROR");
    for (const state of ["DOWNLOAD_FAILED", "CORRUPT", "INSUFFICIENT_STORAGE", "PAUSED_ERROR", "RUNTIME_ERROR", "SOME_FUTURE_NATIVE_STATE"]) {
      expect(managerStatusFrom(state)).not.toBe("INSTALLED_UNVERIFIED");
    }
    expect(managerStatusFrom("INSTALLED")).toBe("INSTALLED_UNVERIFIED");
    expect(managerStatusFrom("PAUSED")).toBe("PAUSED");
  });

  it("routes every lifecycle action by catalogue entry identity, never by bridge guessing", () => {
    const lifecycleActions = ["download", "pause", "resume", "cancel", "verify", "delete"] as const;
    for (const action of lifecycleActions) {
      expect(actionOwnerFor("smolvlm2-500m-litert-int4", action, "RECOMMENDED")).toBe("image");
      expect(actionOwnerFor("qwen3-0.6b-litert-dynamic-int4", action, "RECOMMENDED")).toBe("text");
    }
    expect(actionOwnerFor("smolvlm2-500m-litert-int4", "use", "RECOMMENDED")).toBe("image");
    expect(actionOwnerFor("qwen3-0.6b-litert-dynamic-int4", "use", "RECOMMENDED")).toBe("text");
    for (const entryId of [
      "qwen3-0.6b-litert-mixed-int4",
      "qwen3-0.6b-litert-int8",
      "lfm2.5-1.2b-instruct-litert-int4-gpu",
      "lfm2.5-vl-450m",
    ]) {
      for (const action of lifecycleActions) {
        expect(actionOwnerFor(entryId, action, "EXPERIMENTAL")).toBe("candidate");
      }
      expect(actionOwnerFor(entryId, "use", "EXPERIMENTAL")).toBe("candidate");
    }
    expect(actionOwnerFor("imported-1", "delete", "IMPORTED")).toBe("transfer");
    expect(actionOwnerFor("imported-1", "use", "IMPORTED")).toBe("none");
    expect(actionOwnerFor("imported-1", "verify", "IMPORTED")).toBe("none");
  });
  it("reports Good fit only from measured RAM, never as a run result", () => {
    expect(deviceFitFor(1536, null)).toBe("Not tested on this device");
    expect(deviceFitFor(1536, 4300)).toBe("Good fit");
    expect(deviceFitFor(1536, 512)).toBe("Needs device verification");
  });

  it("applies candidate progress and imported rows without duplicating catalogue ids", () => {
    const base = compactDescriptors();
    const live = applyLiveState(base, {
      vlmStates: [],
      bridgeIdFor: () => null,
      textStatus: null,
      candidateStates: [{ entryId: "lfm2.5-vl-450m", state: "DOWNLOADING", downloadedBytes: 100, error: undefined }],
      candidateProgress: { "lfm2.5-vl-450m": { downloadedBytes: 201 * 1024 * 1024, totalBytes: 406817104 } },
      availableFreeRamMb: 4300,
      canDownloadFor: (id) => id !== "smolvlm2-500m-litert-int4" && id !== "qwen3-0.6b-litert-dynamic-int4",
    });
    const lfm = live.find((m) => m.entryId === "lfm2.5-vl-450m");
    expect(lfm?.state).toBe("DOWNLOADING");
    expect(lfm?.downloadedBytes).toBe(201 * 1024 * 1024);
    const imported = importedToManagerModels([
      { entryId: "imported-1", label: "My Vision Model", role: "Vision", state: "INSTALLED_UNVERIFIED", bytes: 416000000 },
    ]);
    expect(imported[0]).toMatchObject({ category: "IMPORTED", label: "My Vision Model" });
  });
});
