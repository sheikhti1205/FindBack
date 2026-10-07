/**
 * Production boot tests (WS-G): the boot module builds a manager plus an
 * orchestrator whose shared registry reaches installed models with no
 * injected ctx.registry, and stays fail-closed with no seams injected.
 */
import { describe, expect, it } from "vitest";
import type { OfflineAssetPin } from "./offlineModelManager";
import { bootProductionAi } from "./production";

const TEXT_PIN: OfflineAssetPin = {
  modelId: "qwen3-0.6b-dynamic-int4",
  sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
  downloadBytes: 600_000_000,
  minFreeRamMb: 1500,
};

describe("bootProductionAi", () => {
  it("routes through the shared registry with no injected ctx.registry", async () => {
    const boot = bootProductionAi({
      pins: [TEXT_PIN],
      text: {
        modelId: TEXT_PIN.modelId,
        runtimeId: "test-text",
        taskRoles: ["extract-report-fields"],
        isReady: async () => true,
        completeText: async () => "{}",
        completeStructured: async () => JSON.stringify({ fields: { title: "wallet" } }),
      },
    });
    expect(boot.runtimes).toEqual(["local-text"]);
    boot.manager.dispatch(TEXT_PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    boot.manager.dispatch(TEXT_PIN.modelId, { type: "START" });
    boot.manager.dispatch(TEXT_PIN.modelId, {
      type: "PROGRESS",
      downloadedBytes: TEXT_PIN.downloadBytes,
    });
    boot.manager.dispatch(TEXT_PIN.modelId, { type: "VERIFY_START" });
    boot.manager.dispatch(TEXT_PIN.modelId, { type: "VERIFY_OK", actualSha256: TEXT_PIN.sha256 });
    const result = await boot.orchestrator.route(
      "extract-report-fields",
      "a wallet found downtown",
      { traceId: "trace-boot-text" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.actualBackend).toBe("local-text");
      expect(result.provenance.modelId).toBe(TEXT_PIN.modelId);
    }
  });

  it("fails closed with NO_RUNTIME when no backend seam is injected", async () => {
    const boot = bootProductionAi({ pins: [TEXT_PIN] });
    expect(boot.runtimes).toEqual([]);
    const result = await boot.orchestrator.route("embed-texts", { texts: ["hello"] }, {
      traceId: "trace-boot-seamless",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denialReason).toBe("NO_RUNTIME");
    }
  });

  it("throws on duplicate asset ids instead of building a split-brain manager", () => {
    expect(() => bootProductionAi({ pins: [TEXT_PIN, TEXT_PIN] })).toThrow(
      /duplicate asset/,
    );
  });
});
