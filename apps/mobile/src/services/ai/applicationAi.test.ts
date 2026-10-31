import { describe, expect, it } from "vitest";
import { ApplicationAiService, compatibilityOf, DEVICE_INCOMPATIBLE_REASON } from "./applicationAi";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, type ModelDescriptor } from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import type { ModelDownloadDriver } from "./download/driver";

function platform() {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const driver: ModelDownloadDriver = {
    supportedAbis: async () => ["arm64-v8a"],
    rootDir: async () => "/private/ai-models",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async (path) => disk.has(path) ? 1 : 0,
    readJournalText: async () => null,
    download: async (attempt) => {
      calls.push("download");
      attempt.onProgress?.(20, null);
      disk.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    },
    cancelDownload: async () => {},
    hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { disk.delete(path); },
  };
  let resident = false;
  const needle = {
    bridgeName: "needle-cact" as const,
    isNeedleAvailable: async () => resident,
    embeddingDimension: async () => 2,
    loadModel: async () => { calls.push("needle-load"); resident = true; return 2; },
    embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
    initTools: async () => {},
    completeJson: async () => JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] }),
    unload: async () => { calls.push("needle-unload"); resident = false; },
  };
  return { disk, calls, driver, needle };
}

function seedInstalled(service: ApplicationAiService, descriptor: ModelDescriptor) {
  service.manager.dispatch(descriptor.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  service.manager.dispatch(descriptor.modelId, { type: "START" });
  service.manager.dispatch(descriptor.modelId, { type: "VERIFY_START" });
  service.manager.dispatch(descriptor.modelId, { type: "VERIFY_OK", actualSha256: descriptor.sha256 });
}

describe("local intelligence lifecycle", () => {
  it("keeps a corrupt older installed file removable after reconciliation", async () => {
    const p = platform();
    const before = new ApplicationAiService({ android: true, ...p }); await before.ready;
    // The retired photo runtime survives only as an upgrade-cleanup identity.
    const d = SMOL_VISION_DESCRIPTOR;
    const path = before.manager.stagingPathsFor("/private/ai-models", d.modelId, d.revision, d.fileName).installedPath;
    p.disk.set(path, "a".repeat(64));
    const restarted = new ApplicationAiService({ android: true, ...p }); await restarted.ready;
    expect(restarted.manager.statusOf(d.modelId)).toMatchObject({ download: "failed", checksumVerified: false, lastError: "checksum verification failed" });
    await restarted.remove(d.modelId);
    expect(p.disk.has(path)).toBe(false);
    expect(restarted.manager.statusOf(d.modelId)?.download).toBe("not-installed");
  });

  it("retains removable failed state if final directory cleanup fails after model-file deletion", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready; await service.download(NEEDLE_MODEL_ID);
    let fail = true;
    const remove = p.driver.removeFile;
    p.driver.removeFile = async (path) => {
      if (fail && path.endsWith(`/models/${NEEDLE_MODEL_ID}`)) throw new Error("private directory failure");
      await remove(path);
    };
    await expect(service.remove(NEEDLE_MODEL_ID)).rejects.toThrow();
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)).toMatchObject({ download: "failed", checksumVerified: false, lastError: "removal failed" });
    await expect(service.embedNeedle(["umbrella"])).rejects.toThrow();
    fail = false;
    await service.remove(NEEDLE_MODEL_ID);
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.download).toBe("not-installed");
  });

  it("downloads into the shared manager, lazily loads Needle and routes real embeddings; removal revokes readiness", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.download).toBe("installed");
    expect(p.calls).toContain("download");
    expect(await service.embedNeedle(["umbrella", "wallet"])).toEqual([[1, 0], [1, 0]]);
    expect(p.calls).toContain("needle-load");
    await service.remove(NEEDLE_MODEL_ID);
    await expect(service.embedNeedle(["umbrella"])).rejects.toThrow();
  });

  it("claims the model before the first await, so a second tap cannot start a second transfer", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const first = service.download(NEEDLE_MODEL_ID);
    // The second request lands while the first transfer still owns the model.
    await service.download(NEEDLE_MODEL_ID);
    await first;
    expect(p.calls.filter((call) => call === "download")).toHaveLength(1);
  });

  it("releases the claim when the attempt fails, so a retry is never refused", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const realDownload = p.driver.download;
    p.driver.download = async () => { throw new Error("transfer failed"); };
    await service.download(NEEDLE_MODEL_ID);
    expect(service.busy(NEEDLE_MODEL_ID)).toBe(false);
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.download).not.toBe("installed");
    p.driver.download = realDownload;
    await service.download(NEEDLE_MODEL_ID);
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.download).toBe("installed");
  });

  it("notifies subscribers when a claim is released before any transfer exists", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    let seen = 0;
    service.subscribe(() => { seen++; });
    const realDownload = p.driver.download;
    p.driver.download = async () => { throw new Error("transfer failed"); };
    await service.download(NEEDLE_MODEL_ID);
    expect(seen).toBeGreaterThan(0);
    p.driver.download = realDownload;
  });

  it("recovers installs only after rehashing the current pinned file, never from persisted claims", async () => {
    const p = platform();
    const first = new ApplicationAiService({ android: true, ...p }); await first.ready;
    await first.download(NEEDLE_MODEL_ID);
    const path = first.manager.stagingPathsFor("/private/ai-models", NEEDLE_MODEL_ID, NEEDLE_DESCRIPTOR.revision, NEEDLE_DESCRIPTOR.fileName).installedPath;
    expect(p.disk.get(path)).toBe(NEEDLE_DESCRIPTOR.sha256);
    const restarted = new ApplicationAiService({ android: true, ...p }); await restarted.ready;
    expect(restarted.manager.statusOf(NEEDLE_MODEL_ID)).toMatchObject({ download: "installed", checksumVerified: true });
    // A tampered file is not a clean installation on the next boot.
    p.disk.set(path, "b".repeat(64));
    const tampered = new ApplicationAiService({ android: true, ...p }); await tampered.ready;
    expect(tampered.manager.statusOf(NEEDLE_MODEL_ID)).toMatchObject({ download: "failed", checksumVerified: false });
  });

  it("fails closed on web without constructing or contacting native seams", async () => {
    const service = new ApplicationAiService({ android: false });
    await service.ready;
    await expect(service.download(NEEDLE_MODEL_ID)).rejects.toThrow(/Android/);
    await expect(service.embedNeedle(["umbrella"])).rejects.toThrow(/Android/);
  });

  it("tracks single-resident ownership across loads and account reset", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.embedNeedle(["umbrella"]);
    expect(service.residency.owner).toBe("needle");
    await service.resetForAccount();
    expect(p.calls).toContain("needle-unload");
    expect(service.residency.owner).toBe("none");
  });

  it("resolves ownership by descriptor, never by catalogue position", async () => {
    const p = platform();
    const third: ModelDescriptor = { ...NEEDLE_DESCRIPTOR, modelId: "test-third", runtimeId: "test-runtime", sha256: "c".repeat(64) };
    const service = new ApplicationAiService({ android: true, ...p, descriptors: [NEEDLE_DESCRIPTOR, third] });
    await service.ready;
    seedInstalled(service, third);
    await expect(service.remove(third.modelId)).rejects.toThrow(/No production runtime adapter/);
    expect(p.calls).not.toContain("needle-unload");
  });

  it("keeps the gate closed until orphaned native work settles after an abort", async () => {
    const p = platform();
    let release: (() => void) | undefined;
    let started: () => void = () => {};
    const began = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const service = new ApplicationAiService({ android: true, ...p, needle: {
      ...p.needle,
      completeJson: async () => {
        calls += 1;
        if (calls === 1) {
          started();
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
      },
    } });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const controller = new AbortController();
    const flight = service.route("extract-report-fields", { prompt: "red umbrella" }, { traceId: "t", signal: controller.signal });
    await began;
    controller.abort();
    await expect(flight).resolves.toMatchObject({ ok: false });
    // The visible request returned, but the native call is still running: no
    // new inference, removal, or resident switch may start in that window.
    await expect(
      service.route("extract-report-fields", { prompt: "second umbrella" }, { traceId: "t2" }),
    ).rejects.toThrow(/busy/i);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await service.route("extract-report-fields", { prompt: "third umbrella" }, { traceId: "t3" });
    expect(next.ok).toBe(true);
  });

  it("logout aborts the actual route signal, unloads only after native settles, and never delivers stale results", async () => {
    const p = platform();
    let release: (() => void) | undefined;
    let started: () => void = () => {};
    const began = new Promise<void>((resolve) => { started = resolve; });
    const service = new ApplicationAiService({ android: true, ...p, needle: {
      ...p.needle,
      completeJson: async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "late" } }] });
      },
    } });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const flight = service.route("extract-report-fields", { prompt: "red umbrella" }, { traceId: "t" });
    await began;
    await service.resetForAccount(0);
    await expect(flight).resolves.toMatchObject({ ok: false });
    // The unload waits for the orphaned native call, never runs underneath it.
    expect(p.calls).not.toContain("needle-unload");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.calls).toContain("needle-unload");
  });

  it("reset never unloads under native work that outlives the sign-out wait", async () => {
    const p = platform();
    let release: (() => void) | undefined;
    let started: () => void = () => {};
    const began = new Promise<void>((resolve) => { started = resolve; });
    const service = new ApplicationAiService({ android: true, ...p, needle: {
      ...p.needle,
      completeJson: async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return "{}";
      },
    } });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const flight = service.route("extract-report-fields", { prompt: "red umbrella" }, { traceId: "t" });
    await began;
    await service.resetForAccount(0);
    expect(p.calls).not.toContain("needle-unload");
    release?.();
    await flight;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.calls).toContain("needle-unload");
  });

  it("grades device compatibility on ABI and runtime presence", () => {
    const bridges = { needle: true };
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["arm64-v8a"], bridges)).toEqual({ compatible: true });
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["arm64-v8a", "x86_64"], bridges).compatible).toBe(true);
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["x86_64"], bridges)).toEqual({
      compatible: false,
      reason: DEVICE_INCOMPATIBLE_REASON,
    });
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, [], bridges).compatible).toBe(false);
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["arm64-v8a"], { needle: false }).compatible).toBe(false);
  });

  it("refuses downloads on ABI-incompatible Android without staging bytes", async () => {
    const p = platform();
    p.driver.supportedAbis = async () => ["x86_64"];
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await expect(service.download(NEEDLE_MODEL_ID)).rejects.toThrow(DEVICE_INCOMPATIBLE_REASON);
    expect(p.calls).not.toContain("download");
  });

  it("refuses to run an installed model after the device proves incompatible", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    p.driver.supportedAbis = async () => ["x86_64"];
    const restarted = new ApplicationAiService({ android: true, ...p });
    await restarted.ready;
    await expect(restarted.embedNeedle(["umbrella"])).rejects.toThrow();
  });

  it("fails closed for a structured task without a Needle tool schema", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route("embed-texts" as never, { texts: ["umbrella"] }, { traceId: "t" });
    expect(result.ok).toBe(true);
    // A task with no interpreter never succeeds silently.
    const unknown = await service.route("not-a-task" as never, { prompt: "x" }, { traceId: "t" });
    expect(unknown.ok).toBe(false);
  });
});
