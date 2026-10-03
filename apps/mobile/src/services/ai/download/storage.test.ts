/**
 * WS-C storage lifecycle tests (TDD): preflight, traversal guard, atomic
 * promote, and the bounded-partial policy.
 *
 * In-memory `FileSystemAdapter` fake — no real filesystem writes.
 */
import { describe, expect, it } from "vitest";
import {
  StorageError,
  atomicWriteBytes,
  boundedPartialPolicy,
  buildModelPaths,
  preflightCheck,
  promoteStagedFile,
  type FileSystemAdapter,
} from "./storage";

function memoryFs(): FileSystemAdapter & {
  files: Map<string, Uint8Array>;
  writes: string[];
  renames: [string, string][];
  fsyncs: string[];
  failRename: boolean;
} {
  const fs: FileSystemAdapter & {
    files: Map<string, Uint8Array>;
    writes: string[];
    renames: [string, string][];
    fsyncs: string[];
    failRename: boolean;
  } = {
    files: new Map<string, Uint8Array>(),
    writes: [],
    renames: [],
    fsyncs: [],
    failRename: false,
    mkdir: async () => {},
    writeFile: async (path, data) => {
      fs.writes.push(path);
      fs.files.set(path, data.slice());
    },
    readFile: async (path) => {
      const data = fs.files.get(path);
      if (data === undefined) throw new Error(`missing ${path}`);
      return data.slice();
    },
    rename: async (from, to) => {
      if (fs.failRename) throw new Error("rename boom");
      const data = fs.files.get(from);
      if (data === undefined) throw new Error(`missing ${from}`);
      fs.files.delete(from);
      fs.files.set(to, data);
      fs.renames.push([from, to]);
    },
    unlink: async (path) => {
      if (!fs.files.delete(path)) throw new Error(`missing ${path}`);
    },
    fsync: async (path) => {
      fs.fsyncs.push(path);
    },
    freeBytes: async () => 1_000_000_000,
  };
  return fs;
}

describe("storage preflight", () => {
  it("passes when headroom survives the write", () => {
    const result = preflightCheck({
      requiredBytes: 100,
      freeBytes: 500,
      headroomBytes: 50,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("fails closed on low storage with the shortfall", () => {
    const result = preflightCheck({
      requiredBytes: 900,
      freeBytes: 500,
      headroomBytes: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOW_STORAGE");
      expect(result.shortfall).toBe(450);
    }
  });
});

describe("staging path builder", () => {
  it("builds app-private staging + installed paths", () => {
    const paths = buildModelPaths("/data/app", "qwen3-06b", "rev1", "weights/m.gguf");
    expect(paths.stagingPath).toBe("/data/app/staging/qwen3-06b/rev1/weights/m.gguf");
    expect(paths.installedPath).toBe("/data/app/models/qwen3-06b/rev1/weights/m.gguf");
  });

  it("blocks traversal in file paths, model ids, and revisions", () => {
    const badPaths = ["../evil", "/abs/x", "a//b", "win\\evil", "a/./b", ""];
    for (const bad of badPaths) {
      expect(() => buildModelPaths("/data/app", "m", "r1", bad)).toThrowError(StorageError);
    }
    expect(() => buildModelPaths("/data/app", "../m", "r1", "f.gguf")).toThrowError(
      expect.objectContaining({ code: "TRAVERSAL_BLOCKED" }),
    );
    expect(() => buildModelPaths("/data/app", "m", "..", "f.gguf")).toThrowError(
      expect.objectContaining({ code: "TRAVERSAL_BLOCKED" }),
    );
  });
});

describe("atomic promote", () => {
  it("writes tmp, fsyncs, then renames — never a torn final", async () => {
    const fs = memoryFs();
    await atomicWriteBytes(fs, "/data/app/models/m/f.gguf", new Uint8Array([1, 2, 3]));
    expect(fs.writes).toEqual(["/data/app/models/m/f.gguf.tmp"]);
    expect(fs.fsyncs).toEqual(["/data/app/models/m/f.gguf.tmp"]);
    expect(fs.renames).toEqual([
      ["/data/app/models/m/f.gguf.tmp", "/data/app/models/m/f.gguf"],
    ]);
    expect(fs.files.get("/data/app/models/m/f.gguf")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("promotes a staged file through tmp without touching final early", async () => {
    const fs = memoryFs();
    fs.files.set("/data/app/staging/m.gguf", new Uint8Array([9]));
    await promoteStagedFile(fs, "/data/app/staging/m.gguf", "/data/app/models/m.gguf");
    expect(fs.files.get("/data/app/models/m.gguf")).toEqual(new Uint8Array([9]));
    expect(fs.files.has("/data/app/staging/m.gguf")).toBe(false);
    expect(fs.renames).toHaveLength(2);
  });

  it("leaves the final path untouched when the rename fails", async () => {
    const fs = memoryFs();
    fs.files.set("/data/app/staging/m.gguf", new Uint8Array([9]));
    fs.files.set("/data/app/models/m.gguf", new Uint8Array([1]));
    fs.failRename = true;
    await expect(
      promoteStagedFile(fs, "/data/app/staging/m.gguf", "/data/app/models/m.gguf"),
    ).rejects.toThrow();
    expect(fs.files.get("/data/app/models/m.gguf")).toEqual(new Uint8Array([1]));
  });
});

describe("bounded-partial policy", () => {
  it("allows a fitting intake", () => {
    expect(
      boundedPartialPolicy({ stagedBytes: 10, incomingBytes: 20, freeBytes: 1000 }),
    ).toMatchObject({ decision: "allow", allowedBytes: 20 });
  });

  it("truncates the intake but keeps the partial when tight", () => {
    const result = boundedPartialPolicy({
      stagedBytes: 10,
      incomingBytes: 900,
      freeBytes: 100,
      maxPartialBytes: 64,
    });
    expect(result).toMatchObject({ decision: "truncate", keptBytes: 10 });
    if (result.decision === "truncate") {
      expect(result.allowedBytes).toBeLessThanOrEqual(100);
    }
  });

  it("rejects the intake and keeps the partial when nothing fits", () => {
    expect(
      boundedPartialPolicy({ stagedBytes: 77, incomingBytes: 50, freeBytes: 0 }),
    ).toMatchObject({ decision: "reject-partial-kept", keptBytes: 77, allowedBytes: 0 });
  });
});
