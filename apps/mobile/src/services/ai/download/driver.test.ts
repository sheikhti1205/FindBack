/**
 * Managed download tests (B3): gate-first orchestration, journal resume,
 * verify-promote-install, cancel-keeps-bytes, mismatch-deletes-staged,
 * and idempotent remove. Fake driver — no network, no native bridge.
 */
import { describe, expect, it, vi } from "vitest";
import { OfflineModelManager, type OfflineAssetPin } from "../offlineModelManager";
import {
  pauseManagedDownload,
  removeManagedModel,
  runManagedDownload,
  DriverError,
  type ManagedDownloadRequest,
  type ModelDownloadDriver,
} from "./driver";
import { buildJournal } from "./journal";

const PIN: OfflineAssetPin = {
  modelId: "smolvlm2-500m-vision",
  sha256: "c".repeat(64),
  downloadBytes: 1_000,
  minFreeRamMb: 1500,
};

const REQUEST: ManagedDownloadRequest = {
  modelId: PIN.modelId,
  revision: "dad030b6",
  fileName: "model.litertlm",
  url: "https://cdn.example.com/m.litertlm",
  maxBytes: 2_000,
  userInitiated: true,
};

function fakeDriver(opts?: {
  staged?: number;
  journal?: string | null;
  actualHex?: string;
  downloadThrows?: { code: string; message: string };
}): ModelDownloadDriver & {
  downloads: number;
  promotes: [string, string][];
  removed: string[];
  lastOffset: number | null;
} {
  const state = {
    downloads: 0,
    promotes: [] as [string, string][],
    removed: [] as string[],
    lastOffset: null as number | null,
  };
  return {
    downloads: state.downloads,
    get lastOffset() {
      return state.lastOffset;
    },
    promotes: state.promotes,
    removed: state.removed,
    rootDir: async () => "/root/ai-models",
    freeBytes: async () => 10_000_000,
    stagedSize: async () => opts?.staged ?? 0,
    readJournalText: async () => opts?.journal ?? null,
    download: async (attempt) => {
      state.downloads += 1;
      state.lastOffset = attempt.resumeOffset;
      if (opts?.downloadThrows !== undefined) {
        const { code, message } = opts.downloadThrows;
        const error = new Error(message);
        (error as { code?: string }).code = code;
        throw error;
      }
      attempt.onProgress?.(500, 1_000);
      attempt.onProgress?.(1_000, 1_000);
      return {
        receivedBytes: 1_000,
        totalBytes: 1_000,
        actualHex: opts?.actualHex ?? PIN.sha256,
        finalUrl: attempt.url,
      };
    },
    cancelDownload: async () => {},
    hashFile: async () => opts?.actualHex ?? PIN.sha256,
    promoteFile: async (from: string, to: string) => {
      state.promotes.push([from, to]);
    },
    removeFile: async (path: string) => {
      state.removed.push(path);
    },
  };
}

function manager(): OfflineModelManager {
  return new OfflineModelManager([PIN]);
}

describe("managed downloads", () => {
  it("refuses a download that is not user-initiated", async () => {
    const outcome = await runManagedDownload(manager(), fakeDriver(), {
      ...REQUEST,
      userInitiated: false,
    });
    expect(outcome).toMatchObject({ ok: false, code: "NOT_USER_INITIATED" });
  });

  it("refuses an unknown model", async () => {
    const outcome = await runManagedDownload(manager(), fakeDriver(), {
      ...REQUEST,
      modelId: "nope",
    });
    expect(outcome).toMatchObject({ ok: false, code: "UNKNOWN_MODEL" });
  });

  it("runs gate → stream → verify → promote → installed", async () => {
    const mgr = manager();
    const driver = fakeDriver();
    const outcome = await runManagedDownload(mgr, driver, REQUEST);
    expect(outcome).toEqual({ ok: true, modelId: PIN.modelId });
    const status = mgr.statusOf(PIN.modelId);
    expect(status?.download).toBe("installed");
    expect(status?.checksumVerified).toBe(true);
    expect(driver.promotes).toEqual([
      [
        "/root/ai-models/staging/smolvlm2-500m-vision/dad030b6/model.litertlm",
        "/root/ai-models/models/smolvlm2-500m-vision/dad030b6/model.litertlm",
      ],
    ]);
  });

  it("resumes at the reconciled journal offset", async () => {
    const mgr = manager();
    const journal = buildJournal({
      modelId: PIN.modelId,
      revision: "dad030b6",
      filePath: "model.litertlm",
      url: REQUEST.url,
      offset: 400,
      total: 1_000,
      sha: PIN.sha256,
    });
    const driver = fakeDriver({
      staged: 400,
      journal: JSON.stringify(journal),
    });
    const outcome = await runManagedDownload(mgr, driver, REQUEST);
    expect(outcome.ok).toBe(true);
    expect(driver.lastOffset).toBe(400);
  });

  it("restarts from staged size when the journal runs ahead", async () => {
    const mgr = manager();
    const journal = buildJournal({
      modelId: PIN.modelId,
      revision: "dad030b6",
      filePath: "model.litertlm",
      url: REQUEST.url,
      offset: 900,
      total: 1_000,
      sha: PIN.sha256,
    });
    const driver = fakeDriver({ staged: 100, journal: JSON.stringify(journal) });
    const outcome = await runManagedDownload(mgr, driver, REQUEST);
    expect(outcome.ok).toBe(true);
    expect(driver.lastOffset).toBe(100);
  });

  it("deletes staged bytes on checksum mismatch and stays failed", async () => {
    const mgr = manager();
    const driver = fakeDriver({ actualHex: "d".repeat(64) });
    const outcome = await runManagedDownload(mgr, driver, REQUEST);
    expect(outcome).toMatchObject({ ok: false, code: "CHECKSUM_MISMATCH" });
    expect(driver.removed).toContain(
      "/root/ai-models/staging/smolvlm2-500m-vision/dad030b6/model.litertlm",
    );
    expect(driver.promotes).toEqual([]);
    expect(mgr.statusOf(PIN.modelId)?.download).toBe("failed");
  });

  it("records driver failures as failed and keeps bytes for resume", async () => {
    const mgr = manager();
    const driver = fakeDriver({
      downloadThrows: { code: "HTTP_ERROR", message: "HTTP 500" },
    });
    const outcome = await runManagedDownload(mgr, driver, REQUEST);
    expect(outcome.ok).toBe(false);
    expect(mgr.statusOf(PIN.modelId)?.download).toBe("failed");
    expect(driver.removed).toEqual([]);
  });

  it("pauses to CANCEL on abort and keeps staged bytes", async () => {
    const mgr = manager();
    const controller = new AbortController();
    const driver = fakeDriver();
    const download = (attempt: Parameters<ModelDownloadDriver["download"]>[0]) => {
      controller.abort();
      if (attempt.signal?.aborted === true) {
        throw new DriverError("ABORTED", "download cancelled");
      }
      return driver.download(attempt);
    };
    const outcome = await runManagedDownload(mgr, { ...driver, download }, {
      ...REQUEST,
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(mgr.statusOf(PIN.modelId)?.download).toBe("paused");
  });

  it("refuses a second start while downloading", async () => {
    const mgr = manager();
    mgr.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    mgr.dispatch(PIN.modelId, { type: "START" });
    const outcome = await runManagedDownload(mgr, fakeDriver(), REQUEST);
    expect(outcome).toMatchObject({ ok: false, code: "ALREADY_RUNNING" });
  });

  it("pauses an in-flight download via pauseManagedDownload", async () => {
    const mgr = manager();
    mgr.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    mgr.dispatch(PIN.modelId, { type: "START" });
    const driver = fakeDriver();
    const cancel = vi.spyOn(driver, "cancelDownload");
    await pauseManagedDownload(mgr, driver, PIN.modelId, "/s/stage");
    expect(cancel).toHaveBeenCalledWith("/s/stage");
    expect(mgr.statusOf(PIN.modelId)?.download).toBe("paused");
  });

  it("removes every on-disk trace and unloads first", async () => {
    const mgr = manager();
    const driver = fakeDriver();
    const unload = vi.fn(async () => {});
    await removeManagedModel(mgr, driver, "/root/ai-models", PIN.modelId, "dad030b6", "model.litertlm", {
      unload,
    });
    expect(unload).toHaveBeenCalledTimes(1);
    expect(driver.removed).toHaveLength(5);
    expect(mgr.statusOf(PIN.modelId)?.download).toBe("not-installed");
  });
});
