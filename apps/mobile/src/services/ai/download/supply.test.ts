import { describe, expect, it } from "vitest";
import { OfflineModelManager } from "../offlineModelManager";
import { DriverError, runManagedDownload, type DownloadAttempt, type ModelDownloadDriver } from "./driver";

const sha = "a".repeat(64);
const pin = { modelId: "test", sha256: sha, downloadBytes: 10, minFreeRamMb: 1 };
const request = { modelId: "test", revision: "a".repeat(40), fileName: "model.gguf", url: "https://huggingface.co/o/r/resolve/" + "a".repeat(40) + "/model.gguf", maxBytes: 10, userInitiated: true };
function fake(results: (string | number)[]) {
  const attempts: DownloadAttempt[] = [];
  const removed: string[] = [];
  const promoted: string[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", freeBytes: async () => 1000,
    stagedSize: async () => 0, readJournalText: async () => null,
    cancelDownload: async () => {}, hashFile: async () => sha,
    removeFile: async (p) => { removed.push(p); },
    promoteFile: async (_from, to) => { promoted.push(to); },
    download: async (attempt) => {
      attempts.push(attempt);
      const result = results.shift() ?? 10;
      if (typeof result === "string") throw new DriverError(result, "https://signed.example/?secret=never-persist");
      return { receivedBytes: result, totalBytes: result, actualHex: sha, finalUrl: attempt.url };
    },
  };
  return { driver, attempts, removed, promoted };
}
describe("model supply boundary", () => {
  it.each(["TIMEOUT", "HTTP_404", "HTTP_410", "HTTP_429", "HTTP_503", "NETWORK_ERROR"])("fails over %s after clearing staging", async (code) => {
    const f = fake([code, 10]);
    const outcome = await runManagedDownload(new OfflineModelManager([pin]), f.driver, { ...request, sources: [request.url, request.url + "?download=true"] });
    expect(outcome.ok).toBe(true);
    expect(f.attempts).toHaveLength(2);
    expect(f.attempts[1]?.resumeOffset).toBe(0);
    expect(f.removed.some((p) => p.includes("staging"))).toBe(true);
  });
  it.each(["TLS_ERROR", "CHECKSUM_MISMATCH", "SIZE_MISMATCH", "LICENSE_MISMATCH", "HTTP_403"])("never fails over %s or leaks an error URL", async (code) => {
    const f = fake([code, 10]);
    const outcome = await runManagedDownload(new OfflineModelManager([pin]), f.driver, { ...request, sources: [request.url, request.url + "?download=true"] });
    expect(outcome).toMatchObject({ ok: false, code });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(f.attempts).toHaveLength(1);
    expect(f.promoted).toHaveLength(0);
  });
  it("rejects short bytes even with a matching digest", async () => {
    const f = fake([9]);
    expect(await runManagedDownload(new OfflineModelManager([pin]), f.driver, request)).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
    expect(f.promoted).toHaveLength(0);
  });
  it("cannot promote a late completion after abort", async () => {
    const f = fake([10]); const controller = new AbortController();
    const download = f.driver.download;
    f.driver.download = async (a) => { const result = await download(a); controller.abort(); return result; };
    expect(await runManagedDownload(new OfflineModelManager([pin]), f.driver, { ...request, signal: controller.signal })).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(f.promoted).toHaveLength(0);
  });
  it("rejects credential-bearing source URLs before IO", async () => {
    const f = fake([10]);
    expect(await runManagedDownload(new OfflineModelManager([pin]), f.driver, { ...request, url: request.url + "?token=private" })).toMatchObject({ ok: false, code: "BAD_SOURCE" });
    expect(f.attempts).toHaveLength(0);
  });
  it("can retry after cancellation during atomic promotion rather than remaining verifying", async () => {
    const f = fake([10]); const controller = new AbortController(); const manager = new OfflineModelManager([pin]);
    const promote = f.driver.promoteFile;
    f.driver.promoteFile = async (from, to) => { await promote(from, to); controller.abort(); };
    expect(await runManagedDownload(manager, f.driver, { ...request, signal: controller.signal })).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(manager.statusOf(pin.modelId)?.download).toBe("paused");
    expect(f.removed).toContain(f.promoted[0]);
    f.driver.promoteFile = promote;
    expect(await runManagedDownload(manager, f.driver, request)).toMatchObject({ ok: true });
    expect(manager.statusOf(pin.modelId)?.download).toBe("installed");
  });
  it.each(["CHECKSUM_MISMATCH", "SIZE_MISMATCH", "BYTE_BOUND_EXCEEDED", "LICENSE_MISMATCH", "MANIFEST_MISMATCH"])("discards native %s bytes and journal without trying an alternative", async (code) => {
    const f = fake([code, 10]);
    expect(await runManagedDownload(new OfflineModelManager([pin]), f.driver, { ...request, sources: [request.url, request.url + "?download=true"] })).toMatchObject({ ok: false, code });
    expect(f.attempts).toHaveLength(1);
    expect(f.removed.some((path) => path.endsWith("model.gguf"))).toBe(true);
    expect(f.removed.some((path) => path.endsWith(".journal.json"))).toBe(true);
  });
  it("also removes the journal when the service rejects a returned digest", async () => {
    const f = fake([10]); const download = f.driver.download;
    f.driver.download = async (attempt) => ({ ...await download(attempt), actualHex: "b".repeat(64) });
    expect(await runManagedDownload(new OfflineModelManager([pin]), f.driver, request)).toMatchObject({ ok: false, code: "CHECKSUM_MISMATCH" });
    expect(f.removed.some((path) => path.endsWith(".journal.json"))).toBe(true);
  });
});
