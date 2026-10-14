import type { ModelDescriptor } from "../modelDescriptors";
import { acquisitionArtifacts, acquisitionBytes, sourcesFor, validateArtifactMirrors, type ArtifactMirrors } from "../modelSupply";
import { OfflineModelManager } from "../offlineModelManager";
import { runManagedDownload, type ModelDownloadDriver, type ManagedDownloadOutcome } from "./driver";

/** Files are individually verified in an isolated work tree; readiness changes after one directory rename. */
export async function runManagedBundle(manager: OfflineModelManager, driver: ModelDownloadDriver, d: ModelDescriptor, signal: AbortSignal, mirrors: ArtifactMirrors = {}): Promise<ManagedDownloadOutcome> {
  validateArtifactMirrors(d, mirrors);
  const gate = await manager.checkDownloadGate(d.modelId, { userInitiated: true });
  if (!gate.ok) return { ...gate, modelId: d.modelId };
  const root = await driver.rootDir();
  const workRoot = `${root}/bundle-work`;
  const from = `${workRoot}/models/${d.modelId}/${d.revision}`;
  const to = `${root}/models/${d.modelId}/${d.revision}`;
  if (await driver.freeBytes() < acquisitionBytes(d) + 64 * 1024 ** 2) return { ok: false, modelId: d.modelId, code: "INSUFFICIENT_STORAGE", reason: "Needs more storage" };
  if (manager.statusOf(d.modelId)?.download !== "paused") manager.dispatch(d.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(d.modelId, { type: "START" });
  const fileDriver: ModelDownloadDriver = {
    rootDir: async () => workRoot, freeBytes: () => driver.freeBytes(), stagedSize: (p) => driver.stagedSize(p), readJournalText: (p) => driver.readJournalText(p),
    download: (a) => driver.download(a), cancelDownload: (p) => driver.cancelDownload(p), hashFile: (p) => driver.hashFile(p),
    promoteFile: (a, b) => driver.promoteFile(a, b), removeFile: (p) => driver.removeFile(p),
  };
  try {
    for (const file of acquisitionArtifacts(d)) {
      const pins = new OfflineModelManager([{ modelId: d.modelId, sha256: file.sha256, downloadBytes: file.bytes, minFreeRamMb: d.minRamMb }]);
      const result = await runManagedDownload(pins, fileDriver, { ...file, sources: sourcesFor(file, mirrors[file.fileName]), modelId: d.modelId, revision: d.revision, maxBytes: file.bytes, userInitiated: true, signal });
      if (!result.ok) {
        manager.dispatch(d.modelId, signal.aborted ? { type: "CANCEL" } : { type: "FAIL", reason: result.reason });
        return result;
      }
    }
    if (signal.aborted || manager.statusOf(d.modelId)?.download !== "downloading") throw new Error("cancelled");
    manager.dispatch(d.modelId, { type: "VERIFY_START" });
    await driver.promoteFile(from, to);
    if (signal.aborted || manager.statusOf(d.modelId)?.download !== "verifying") {
      await driver.removeFile(to); throw new Error("cancelled");
    }
    manager.dispatch(d.modelId, { type: "VERIFY_OK", actualSha256: d.sha256 });
    await driver.removeFile(`${workRoot}/staging/${d.modelId}`);
    return { ok: true, modelId: d.modelId };
  } catch {
    if (manager.statusOf(d.modelId)?.download === "downloading" || manager.statusOf(d.modelId)?.download === "verifying") {
      manager.dispatch(d.modelId, signal.aborted ? { type: "CANCEL" } : { type: "FAIL", reason: "Bundle could not be installed." });
    }
    return { ok: false, modelId: d.modelId, code: signal.aborted ? "CANCELLED" : "BUNDLE_FAILED", reason: "Bundle could not be installed." };
  }
}
