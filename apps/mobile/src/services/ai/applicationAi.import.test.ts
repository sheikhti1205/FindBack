import { expect, it } from "vitest";
import { ApplicationAiService } from "./applicationAi";
import type { ModelDownloadDriver } from "./download/driver";

const hash = "a".repeat(64);
const input = { sha256: hash, bytes: 12, format: "gguf" as const, license: "Apache-2.0", url: "https://example.org/model.gguf" };

function fixture(options: { saveFails?: boolean; downloadFails?: boolean } = {}) {
  const disk = new Map<string, string>();
  let metadata: string | null = null;
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", freeBytes: async () => 1e10,
    stagedSize: async () => 0, readJournalText: async () => null,
    readMetadata: async () => metadata,
    writeMetadata: async (_path, value) => { if (options.saveFails) throw new Error("storage unavailable"); metadata = value; },
    hashFile: async (path) => disk.get(path) ?? "",
    cancelDownload: async () => {},
    removeFile: async (path) => { for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key); },
    promoteFile: async (from, to) => {
      for (const [path, value] of [...disk]) {
        if (path === from || path.startsWith(`${from}/`)) { disk.set(`${to}${path.slice(from.length)}`, value); disk.delete(path); }
      }
    },
    download: async (request) => {
      if (options.downloadFails) throw new Error("HTTP_403");
      disk.set(request.stagingPath, request.expectedSha256);
      return { receivedBytes: request.maxBytes, totalBytes: request.maxBytes, actualHex: request.expectedSha256, finalUrl: request.url };
    },
    pickAndStage: async (request) => { disk.set(request.stagingPath, hash); return { bytes: 12, actualHex: hash }; },
  };
  const llama = { bridgeName: "llama-cpp-lab", isLlamaAvailable: async () => true, loadLlamaModel: async () => {}, unloadLlamaModel: async () => {}, cancelGeneration: async () => {}, inferLlama: async function* () {} };
  const smol = { bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false, loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {}, describeImage: async function* () {}, collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }) };
  const service = new ApplicationAiService({ android: true, driver, llama, smol });
  return { service, disk, driver, metadata: () => metadata, llama, smol };
}

it("rolls back local installation and its ready claim when private metadata cannot be saved", async () => {
  const { service, disk } = fixture({ saveFails: true });
  await service.ready;
  await expect(service.importLocal({ format: "gguf", license: "Apache-2.0" })).rejects.toThrow("storage unavailable");
  expect([...disk.keys()].filter((path) => path.includes("imported-"))).toEqual([]);
  expect(service.manager.statusOf(`imported-${hash}`)?.download).not.toBe("installed");
  expect(service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
});

it("does not retain a failed URL import or its source in the live catalogue", async () => {
  const { service, metadata } = fixture({ downloadFails: true });
  await service.ready;
  await expect(service.importUrl(input)).rejects.toThrow();
  expect(service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
  expect(metadata()).toBeNull();
});

it("rolls back URL installation when saving its identity fails", async () => {
  const { service, disk } = fixture({ saveFails: true });
  await service.ready;
  await expect(service.importUrl(input)).rejects.toThrow("storage unavailable");
  expect([...disk.keys()].filter((path) => path.includes("imported-"))).toEqual([]);
  expect(service.manager.statusOf(`imported-${hash}`)?.download).not.toBe("installed");
  expect(service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
});

it("keeps imported identity across restart without retaining its acquisition URL or adding product roles", async () => {
  const f = fixture(); await f.service.ready;
  const modelId = await f.service.importUrl(input);
  expect(f.metadata()).not.toContain("https:");
  const restarted = new ApplicationAiService({ android: true, driver: f.driver, llama: f.llama, smol: f.smol });
  await restarted.ready;
  expect(restarted.registry.requireDescriptor(modelId)).toMatchObject({ trust: "imported", maturity: "lab", url: "", taskRoles: [], untrustedImport: true });
  expect(restarted.manager.statusOf(modelId)?.download).toBe("installed");
});

it("never registers an untrusted import as a production task backend", async () => {
  const f = fixture(); await f.service.ready;
  const modelId = await f.service.importUrl(input);
  const d = f.service.registry.requireDescriptor(modelId);
  expect(d.untrustedImport).toBe(true);
  expect(d.taskRoles).toEqual([]);
  // Production backends are served by task roles; an untrusted import has no
  // roles, so no product task can select it even though its runtime is the
  // production bridge. This invariant must hold for every registry entry.
  for (const entry of f.service.registry.descriptors) {
    if (entry.untrustedImport === true) expect(entry.taskRoles).toEqual([]);
  }
});

it("cannot change an already installed import format under the same hash-derived identity", async () => {
  const f = fixture(); await f.service.ready;
  const modelId = await f.service.importUrl(input);
  await expect(f.service.importUrl({ ...input, format: "litertlm" })).rejects.toThrow("identity");
  expect(f.service.registry.requireDescriptor(modelId).format).toBe("gguf");
  expect(f.service.manager.statusOf(modelId)?.download).toBe("installed");
});

it("cannot evaluate an import before its persistence transaction settles", async () => {
  const f = fixture(); await f.service.ready;
  let arrived!: () => void; let release!: () => void;
  const saving = new Promise<void>((resolve) => { arrived = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const save = f.driver.writeMetadata!;
  f.driver.writeMetadata = async (path, value) => { arrived(); await deferred; await save(path, value); };
  const importing = f.service.importUrl(input);
  await saving;
  try {
    await expect(f.service.evaluate(`imported-${hash}`, { optIn: true, prompt: "hello" })).rejects.toThrow("busy");
  } finally { release(); await importing; }
});

it("does not begin a URL acquisition for a pre-cancelled operation", async () => {
  const f = fixture(); await f.service.ready;
  const controller = new AbortController(); controller.abort();
  await expect(f.service.importUrl(input, { signal: controller.signal })).rejects.toThrow("cancelled");
  expect(f.disk.size).toBe(0);
  expect(f.metadata()).toBeNull();
  expect(f.service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
});

it("persists an explicitly selected local vision runtime across restart", async () => {
  const f = fixture(); f.smol.isVisionAvailable = async () => true; await f.service.ready;
  const id = await f.service.importLocal({ format: "litertlm", modality: "vision", license: "Apache-2.0" });
  expect(f.service.registry.requireDescriptor(id)).toMatchObject({ runtimeId: "smolvlm2-litertlm", capabilities: ["vision"], trust: "imported", taskRoles: [] });
  const restarted = new ApplicationAiService({ android: true, driver: f.driver, smol: f.smol, llama: f.llama });
  await restarted.ready;
  expect(restarted.registry.requireDescriptor(id)).toMatchObject({ runtimeId: "smolvlm2-litertlm", capabilities: ["vision"], trust: "imported", taskRoles: [] });
  expect(restarted.manager.statusOf(id)?.download).toBe("installed");
});

it("releases the import busy guard even when staging cleanup fails", async () => {
  const f = fixture(); await f.service.ready;
  const remove = f.driver.removeFile; let failOnce = true;
  f.driver.removeFile = async (path) => {
    if (failOnce && path.includes("import-work/")) { failOnce = false; throw new Error("cleanup unavailable"); }
    await remove(path);
  };
  await expect(f.service.importLocal({ format: "gguf", license: "Apache-2.0" })).rejects.toThrow("cleanup unavailable");
  expect(f.service.busy("import")).toBe(false);
  expect(f.service.manager.statusOf(`imported-${hash}`)?.download).not.toBe("installed");
  expect(f.service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
});

it("rolls back a local import cancelled while saving its private catalogue", async () => {
  const f = fixture(); await f.service.ready;
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const save = f.driver.writeMetadata!; let first = true;
  f.driver.writeMetadata = async (path, value) => { if (first) { first = false; arrive(); await deferred; } await save(path, value); };
  const controller = new AbortController();
  const importing = f.service.importLocal({ format: "gguf", license: "Apache-2.0", signal: controller.signal });
  await arrived; controller.abort(); release();
  await expect(importing).rejects.toThrow("cancelled");
  expect(f.service.registry.descriptorFor(`imported-${hash}`)).toBeUndefined();
  expect(f.service.manager.statusOf(`imported-${hash}`)?.download).not.toBe("installed");
  expect(f.metadata()).toBe("[]");
  expect([...f.disk.keys()].some((path) => path.includes("/models/"))).toBe(false);
});

it("does not start two transfers for simultaneous requests for the same identity", async () => {
  const f = fixture(); await f.service.ready;
  const transfer = f.driver.download; let count = 0;
  f.driver.download = async (request) => { count++; return transfer(request); };
  await Promise.all([f.service.download("granite-3.3-2b-instruct-q4_0"), f.service.download("granite-3.3-2b-instruct-q4_0")]);
  expect(count).toBe(1);
});

it("a racing duplicate cannot erase the cancellation owner of an in-progress transfer", async () => {
  const f = fixture(); await f.service.ready;
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const transfer = f.driver.download; let cancelled = 0;
  f.driver.download = async (request) => { arrive(); await deferred; return transfer(request); };
  f.driver.cancelDownload = async () => { cancelled++; release(); };
  const first = f.service.download("granite-3.3-2b-instruct-q4_0");
  const duplicate = f.service.download("granite-3.3-2b-instruct-q4_0");
  await arrived; await duplicate;
  try {
    await f.service.pause("granite-3.3-2b-instruct-q4_0");
    expect(cancelled).toBe(1);
  } finally { release(); await first; }
});

it("an acquisition still awaiting device facts cannot start after an account reset completed", async () => {
  const f = fixture(); await f.service.ready;
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  f.smol.collectDeviceFacts = async () => { arrive(); await deferred; return { supportedAbis: ["arm64-v8a"] }; };
  const acquiring = f.service.download("granite-3.3-2b-instruct-q4_0");
  await arrived; await f.service.resetForAccount(); release();
  await expect(acquiring).rejects.toThrow("cancelled");
  expect(f.disk.size).toBe(0);
});
