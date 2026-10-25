/**
 * Offline adapter helper tests (AI-023).
 *
 * Covers only the pure helpers in `./offline` — readiness verdicts,
 * storage/memory estimates, and prompt building. The full adapter +
 * manager lifecycle is covered by `services/ai/offline.test.ts`. No
 * network, no model binaries, no native bridge: everything past the
 * TypeScript boundary is faked.
 */
import { describe, expect, it } from "vitest";
import { OfflineModelManager, type OfflineAssetPin } from "../offlineModelManager";
import {
  OFFLINE_PROVIDER_ID,
  buildOfflinePrompt,
  createOfflineAdapter,
  describeOfflineReadiness,
  estimateOfflineMemoryMb,
  estimateOfflineStorage,
} from "./offline";
import type { NormalizedRequest } from "../providerContract";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR } from "../modelDescriptors";

const PIN: OfflineAssetPin = {
  modelId: "qwen3-0.6b-dynamic-int4",
  sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
  downloadBytes: 600_000_000,
  minFreeRamMb: 1500,
};

function installedManager(): OfflineModelManager {
  const manager = new OfflineModelManager([PIN]);
  manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(PIN.modelId, { type: "START" });
  manager.dispatch(PIN.modelId, {
    type: "PROGRESS",
    downloadedBytes: PIN.downloadBytes,
  });
  manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
  manager.dispatch(PIN.modelId, { type: "VERIFY_OK", actualSha256: PIN.sha256 });
  return manager;
}

function baseRequest(): NormalizedRequest {
  const controller = new AbortController();
  return {
    selection: {
      accountId: "acct-1",
      provider: OFFLINE_PROVIDER_ID,
      modelId: PIN.modelId,
      mode: "free-only",
    },
    task: "app-help",
    policyVersion: "p1",
    knowledgeVersion: "k1",
    recentTurns: [{ id: "t1", role: "user", text: "Hi", attachmentIds: [], createdAt: "t" }],
    currentText: "Hello",
    approvedImageIds: [],
    authorizedResultIds: [],
    maxOutputTokens: 128,
    signal: controller.signal,
  };
}

describe("offline provider identity", () => {
  it("serves the dedicated offline union member (IF-002), never a custom string", () => {
    expect(OFFLINE_PROVIDER_ID).toBe("offline");
  });

  it("keeps historical names but grants no retired roles in the low-level catalogue, without native inference", async () => {
    const pins = [NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR].map((descriptor) => ({
      modelId: descriptor.modelId, sha256: descriptor.sha256,
      downloadBytes: descriptor.bytes, minFreeRamMb: descriptor.minRamMb,
    }));
    const manager = new OfflineModelManager(pins);
    for (const pin of pins) {
      manager.dispatch(pin.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      manager.dispatch(pin.modelId, { type: "START" });
      manager.dispatch(pin.modelId, { type: "PROGRESS", downloadedBytes: pin.downloadBytes });
      manager.dispatch(pin.modelId, { type: "VERIFY_START" });
      manager.dispatch(pin.modelId, { type: "VERIFY_OK", actualSha256: pin.sha256 });
    }
    const adapter = createOfflineAdapter({ manager, bridge: {
      bridgeName: "Never needed for catalogue",
      isAvailable: () => { throw new Error("Catalogue must not probe the runtime"); },
      load: async () => { throw new Error("Catalogue must not load a runtime"); },
      unload: async () => { throw new Error("Catalogue must not unload a runtime"); },
      async *generate() { yield await Promise.reject<never>(new Error("Catalogue must not generate")); },
    } });
    const rows = await adapter.listModels!();
    expect(rows.map(({ displayName, qualifiedRoles }) => ({ displayName, qualifiedRoles }))).toEqual([
      { displayName: "Needle3", qualifiedRoles: ["tools", "embeddings"] },
      // ApplicationAiService filters cleanup-only rows entirely; this generic
      // transport owner must not resurrect their old qualification either.
      { displayName: "SmolVLM2", qualifiedRoles: [] },
    ]);
  });
});

describe("describeOfflineReadiness", () => {
  it("reports unknown models fail-closed", () => {
    const readiness = describeOfflineReadiness(new OfflineModelManager([PIN]), "nope");
    expect(readiness).toMatchObject({ ready: false, code: "unknown_model" });
  });

  it("reports a not-installed model without claiming readiness", () => {
    const readiness = describeOfflineReadiness(new OfflineModelManager([PIN]), PIN.modelId);
    expect(readiness).toMatchObject({ ready: false, code: "model_not_installed" });
  });

  it("reports ready only for installed and verified models", () => {
    expect(describeOfflineReadiness(installedManager(), PIN.modelId)).toMatchObject({
      ready: true,
      modelId: PIN.modelId,
    });
  });

  it("refuses checksum-unverified installs even when bytes are present", () => {
    const manager = new OfflineModelManager([PIN]);
    manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    manager.dispatch(PIN.modelId, { type: "START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_FAIL", reason: "hash mismatch" });
    // Failed downloads are not installed at all.
    expect(describeOfflineReadiness(manager, PIN.modelId)).toMatchObject({
      ready: false,
      code: "model_not_installed",
    });
  });
});

describe("offline estimates", () => {
  it("splits total/staged/remaining storage bytes", () => {
    expect(estimateOfflineStorage(PIN, 100)).toMatchObject({
      modelId: PIN.modelId,
      totalBytes: PIN.downloadBytes,
      stagedBytes: 100,
      remainingBytes: PIN.downloadBytes - 100,
    });
  });

  it("clamps staged bytes to finite non-negative integers", () => {
    expect(estimateOfflineStorage(PIN, Number.NaN).stagedBytes).toBe(0);
    expect(estimateOfflineStorage(PIN, -5).stagedBytes).toBe(0);
    expect(estimateOfflineStorage(PIN, PIN.downloadBytes + 10).remainingBytes).toBe(0);
  });

  it("reports the advisory RAM floor verbatim from asset facts", () => {
    expect(estimateOfflineMemoryMb(PIN)).toBe(1500);
  });
});

describe("buildOfflinePrompt", () => {
  it("carries task, turns, and current text with no image bytes", () => {
    const prompt = buildOfflinePrompt(baseRequest(), "Be helpful.");
    expect(prompt.modelId).toBe(PIN.modelId);
    expect(prompt.task).toBe("app-help");
    expect(prompt.systemText).toBe("Be helpful.");
    expect(prompt.currentText).toBe("Hello");
    expect(prompt.recentTurns).toEqual([{ role: "user", text: "Hi" }]);
    expect(JSON.stringify(prompt)).not.toMatch(/data:|base64/);
  });

  it("omits empty system text and blank turns", () => {
    const request = { ...baseRequest(), currentText: "  ", systemText: undefined };
    const prompt = buildOfflinePrompt(request, "   ");
    expect("systemText" in prompt).toBe(false);
    expect(prompt.recentTurns).toEqual([{ role: "user", text: "Hi" }]);
  });
});
