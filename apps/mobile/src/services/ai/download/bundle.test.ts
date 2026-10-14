import { expect, it } from "vitest";
import { runManagedBundle } from "./bundle";
import { OfflineModelManager } from "../offlineModelManager";
import type { ModelDownloadDriver } from "./driver";
import { productionModelRegistry } from "../modelDescriptors";
it("verifies both language and projector before one atomic directory promotion", async () => {
  const d = productionModelRegistry().requireDescriptor("lfm2-vl-450m-q4_0");
  const m = new OfflineModelManager([{ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: 1 }]);
  const promotions: string[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", freeBytes: async () => 1e10, stagedSize: async () => 0, readJournalText: async () => null,
    cancelDownload: async () => {}, removeFile: async () => {}, hashFile: async () => "",
    promoteFile: async (_from, to) => { promotions.push(to); },
    download: async (a) => ({ receivedBytes: a.maxBytes, totalBytes: a.maxBytes, actualHex: a.expectedSha256, finalUrl: a.url }),
  };
  expect(await runManagedBundle(m, driver, d, new AbortController().signal)).toMatchObject({ ok: true });
  expect(promotions.at(-1)).toBe(`/private/models/${d.modelId}/${d.revision}`);
  expect(m.statusOf(d.modelId)?.checksumVerified).toBe(true);
});

it("uses a separate same-byte mirror for each artifact and keeps both immutable pins", async () => {
  const d = productionModelRegistry().requireDescriptor("lfm2-vl-450m-q4_0");
  const projector = d.companions![0]!;
  const m = new OfflineModelManager([{ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: 1 }]);
  const requests: { url: string; sha: string; bytes: number }[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", freeBytes: async () => 1e10, stagedSize: async () => 0, readJournalText: async () => null,
    cancelDownload: async () => {}, removeFile: async () => {}, hashFile: async () => "", promoteFile: async () => {},
    download: async (a) => { requests.push({ url: a.url, sha: a.expectedSha256, bytes: a.maxBytes }); return { receivedBytes: a.maxBytes, totalBytes: a.maxBytes, actualHex: a.expectedSha256, finalUrl: a.url }; },
  };
  const mirrors = { [d.fileName]: "https://mirror.example.org/language.gguf", [projector.fileName]: "https://mirror.example.org/projector.gguf" };
  expect(await runManagedBundle(m, driver, d, new AbortController().signal, mirrors)).toMatchObject({ ok: true });
  expect(requests).toEqual([
    { url: mirrors[d.fileName], sha: d.sha256, bytes: d.bytes },
    { url: mirrors[projector.fileName], sha: projector.sha256, bytes: projector.bytes },
  ]);
});

it("never promotes the bundle when the projector checksum is corrupt", async () => {
  const d = productionModelRegistry().requireDescriptor("lfm2-vl-450m-q4_0");
  const m = new OfflineModelManager([{ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: 1 }]);
  const promotions: string[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", freeBytes: async () => 1e10, stagedSize: async () => 0, readJournalText: async () => null,
    cancelDownload: async () => {}, removeFile: async () => {}, hashFile: async () => "", promoteFile: async (_from, to) => { promotions.push(to); },
    download: async (a) => ({ receivedBytes: a.maxBytes, totalBytes: a.maxBytes, actualHex: a.stagingPath.includes("mmproj") ? "b".repeat(64) : a.expectedSha256, finalUrl: a.url }),
  };
  expect(await runManagedBundle(m, driver, d, new AbortController().signal)).toMatchObject({ ok: false });
  expect(promotions).not.toContain(`/private/models/${d.modelId}/${d.revision}`);
  expect(m.statusOf(d.modelId)?.download).not.toBe("installed");
  expect(m.statusOf(d.modelId)?.checksumVerified).toBe(false);
});
