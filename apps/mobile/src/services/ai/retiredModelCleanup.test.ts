import { describe, expect, it } from "vitest";
import { ApplicationAiService } from "./applicationAi";
import { productionModelRegistry } from "./modelDescriptors";
import type { ModelDownloadDriver } from "./download/driver";

const formerlyCurated = [
  "qwen3-1.7b-dynamic-int4", "lfm2-350m-q4_0", "lfm2-700m-q4_0",
  "lfm2-1.2b-q4_0", "granite-3.3-2b-instruct-q4_0", "lfm2-vl-450m-q4_0",
  "lfm2-vl-1.6b-q4_0", "qwen3-vl-2b-instruct-q4_k_m", "lfm2.5-1.2b-q4_0",
  "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb",
];

describe("upgrade cleanup, never a model catalogue", () => {
  it.each(formerlyCurated)("rediscovers and removes old %s bytes without an engine", async (id) => {
    const registry = productionModelRegistry();
    const descriptor = registry.requireDescriptor(id);
    expect(descriptor).toMatchObject({ cleanupOnly: true, downloadable: false, importable: false, taskRoles: [] });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(registry.catalogue().some((model) => model.modelId === id)).toBe(false);
    const disk = new Map<string, string>();
    const removed: string[] = [];
    const root = "/private/models";
    const driver: ModelDownloadDriver = {
      rootDir: async () => root, supportedAbis: async () => ["arm64-v8a"],
      freeBytes: async () => 1e10, stagedSize: async () => 0,
      readJournalText: async () => null, cancelDownload: async () => {},
      download: async () => { throw new Error("Retired artifacts cannot be acquired"); },
      promoteFile: async () => { throw new Error("No promotion during cleanup"); },
      hashFile: async (path) => disk.get(path) ?? "",
      removeFile: async (path) => {
        removed.push(path);
        for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
      },
    };
    const installed = `${root}/models/${id}/${descriptor.revision}/${descriptor.fileName}`;
    disk.set(installed, descriptor.sha256);
    for (const file of descriptor.companions ?? []) {
      disk.set(`${root}/models/${id}/${descriptor.revision}/${file.fileName}`, file.sha256);
    }
    const service = new ApplicationAiService({ android: true, driver });
    await service.ready;
    expect(service.manager.statusOf(id)).toMatchObject({ download: "installed", checksumVerified: true });
    await expect(service.download(id)).rejects.toThrow(/no longer available/i);
    await service.remove(id);
    expect(removed).toContain(`${root}/models/${id}`);
    expect(disk.size).toBe(0);
    expect(service.manager.statusOf(id)?.download).toBe("not-installed");
  });
});
