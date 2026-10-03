/**
 * WS-C installer tests (TDD): verify-then-install, pause/resume, delete,
 * and side-by-side update-then-switch.
 *
 * In-memory filesystem + stub hasher — no real hashes, no real files.
 */
import { describe, expect, it, vi } from "vitest";
import {
  deleteModel,
  installedFileCandidates,
  pauseDownload,
  prepareUpdateStaging,
  resumeOffset,
  switchAfterVerify,
  verifyChecksumMatch,
  verifyThenInstall,
  type HashComputer,
} from "./installer";
import type { FileSystemAdapter } from "./storage";
import { OfflineModelManager } from "../offlineModelManager";

const GOOD_HEX = "a".repeat(64);
const BAD_HEX = "b".repeat(64);

function memoryFs(): FileSystemAdapter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    mkdir: async () => {},
    writeFile: async (path, data) => {
      files.set(path, data.slice());
    },
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`missing ${path}`);
      return data.slice();
    },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw new Error(`missing ${path}`);
    },
    fsync: async () => {},
    freeBytes: async () => 1_000_000_000,
  };
}

function stubHasher(actualHex: string): HashComputer {
  return { sha256Hex: async () => actualHex };
}

const PATHS = {
  stagingPath: "/app/staging/m/r1/f.gguf",
  installedPath: "/app/models/m/r1/f.gguf",
};

describe("verify-then-install", () => {
  it("installs on an exact SHA match", async () => {
    const fs = memoryFs();
    const outcome = await verifyThenInstall(
      fs,
      stubHasher(GOOD_HEX),
      PATHS,
      new Uint8Array([1, 2, 3]),
      GOOD_HEX,
    );
    expect(outcome).toMatchObject({ ok: true, state: "INSTALLED", actualHex: GOOD_HEX });
    expect(fs.files.get(PATHS.installedPath)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("deletes staged bytes and reports NOT_INSTALLED on mismatch", async () => {
    const fs = memoryFs();
    fs.files.set(PATHS.stagingPath, new Uint8Array([9]));
    const outcome = await verifyThenInstall(
      fs,
      stubHasher(BAD_HEX),
      PATHS,
      new Uint8Array([9]),
      GOOD_HEX,
    );
    expect(outcome).toMatchObject({ ok: false, state: "NOT_INSTALLED", actualHex: BAD_HEX });
    expect(fs.files.has(PATHS.stagingPath)).toBe(false);
    expect(fs.files.has(PATHS.installedPath)).toBe(false);
  });

  it("compares hex exactly (case-insensitive, malformed never matches)", () => {
    expect(verifyChecksumMatch(GOOD_HEX, GOOD_HEX.toUpperCase())).toBe(true);
    expect(verifyChecksumMatch(GOOD_HEX, BAD_HEX)).toBe(false);
    expect(verifyChecksumMatch("", GOOD_HEX)).toBe(false);
    expect(verifyChecksumMatch("zzz", GOOD_HEX)).toBe(false);
  });
});

describe("pause and resume", () => {
  it("preserves the journal offset across pause/resume", () => {
    const journal = { url: "https://cdn.example.com/m", offset: 1234, sha: GOOD_HEX };
    const paused = pauseDownload(journal);
    expect(paused.resumeOffset).toBe(1234);
    expect(resumeOffset(journal)).toBe(1234);
  });
});

describe("delete", () => {
  it("unloads first, then removes files, partials, and caches", async () => {
    const fs = memoryFs();
    const order: string[] = [];
    const candidates = installedFileCandidates(PATHS);
    for (const path of candidates) fs.files.set(path, new Uint8Array([1]));
    const outcome = await deleteModel(fs, candidates, {
      unload: async () => {
        order.push("unload");
      },
    });
    expect(outcome.state).toBe("NOT_INSTALLED");
    expect(outcome.removed).toHaveLength(candidates.length);
    expect(fs.files.size).toBe(0);
    expect(order).toEqual(["unload"]);
  });

  it("is idempotent when files are already gone", async () => {
    const fs = memoryFs();
    const unload = vi.fn(async () => {});
    const outcome = await deleteModel(fs, installedFileCandidates(PATHS), { unload });
    expect(outcome.state).toBe("NOT_INSTALLED");
    expect(outcome.removed).toEqual([]);
    expect(unload).toHaveBeenCalledOnce();
  });
});

describe("manager delegation to download modules", () => {
  const PIN = {
    modelId: "m",
    sha256: GOOD_HEX,
    downloadBytes: 1000,
    minFreeRamMb: 0,
  };

  it("delegates checksum, preflight, paths, and journal offset", () => {
    const manager = new OfflineModelManager([PIN]);
    expect(manager.checksumsMatch(GOOD_HEX, GOOD_HEX.toUpperCase())).toBe(true);
    expect(manager.checksumsMatch(GOOD_HEX, BAD_HEX)).toBe(false);
    expect(
      manager.preflightForDownload(100, 500, 50),
    ).toMatchObject({ ok: true });
    expect(
      manager.preflightForDownload(900, 500, 50).ok,
    ).toBe(false);
    expect(
      manager.stagingPathsFor("/app", "m", "r1", "f.gguf").stagingPath,
    ).toBe("/app/staging/m/r1/f.gguf");
    expect(
      manager.resumeOffsetFrom({ url: "https://x.example/m", offset: 7, sha: GOOD_HEX }),
    ).toBe(7);
  });

  it("records journal progress as staged bytes for resume", () => {
    const manager = new OfflineModelManager([PIN]);
    manager.dispatch("m", { type: "QUEUE_DOWNLOAD", userInitiated: true });
    manager.dispatch("m", { type: "START" });
    const status = manager.recordJournalProgress("m", {
      url: "https://x.example/m",
      offset: 512,
      sha: GOOD_HEX,
    });
    expect(status.downloadedBytes).toBe(512);
  });
});

describe("side-by-side update-then-switch", () => {
  it("stages the new revision apart from the current one", () => {
    const staging = prepareUpdateStaging("/app", "m", "r1", "r2", "f.gguf");
    expect(staging.current.installedPath).toContain("/r1/");
    expect(staging.next.installedPath).toContain("/r2/");
    expect(staging.next.installedPath).not.toBe(staging.current.installedPath);
  });

  it("switches only after the new revision verifies", async () => {
    const fs = memoryFs();
    fs.files.set("/app/models/m/r1/f.gguf", new Uint8Array([1]));
    const staging = prepareUpdateStaging("/app", "m", "r1", "r2", "f.gguf");
    const outcome = await switchAfterVerify(
      fs,
      stubHasher(GOOD_HEX),
      staging,
      new Uint8Array([2]),
      GOOD_HEX,
      "r1",
      "r2",
    );
    expect(outcome).toMatchObject({ switched: true, activeRevision: "r2" });
    expect(fs.files.get("/app/models/m/r2/f.gguf")).toEqual(new Uint8Array([2]));
    // Current revision bytes are untouched by the switch.
    expect(fs.files.get("/app/models/m/r1/f.gguf")).toEqual(new Uint8Array([1]));
  });

  it("keeps the current revision active when the new one mismatches", async () => {
    const fs = memoryFs();
    fs.files.set("/app/models/m/r1/f.gguf", new Uint8Array([1]));
    const staging = prepareUpdateStaging("/app", "m", "r1", "r2", "f.gguf");
    const outcome = await switchAfterVerify(
      fs,
      stubHasher(BAD_HEX),
      staging,
      new Uint8Array([2]),
      GOOD_HEX,
      "r1",
      "r2",
    );
    expect(outcome).toMatchObject({ switched: false, activeRevision: "r1" });
    expect(fs.files.has("/app/models/m/r2/f.gguf")).toBe(false);
    expect(fs.files.get("/app/models/m/r1/f.gguf")).toEqual(new Uint8Array([1]));
  });
});
