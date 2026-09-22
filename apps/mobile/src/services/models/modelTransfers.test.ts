import { describe, expect, it } from "vitest";
import type { ModelCatalogueEntry } from "./catalogueTypes";
import {
  checkDownloadGate,
  downloadModel,
  exportPackage,
  findUnsafePathReason,
  hasDeniedMagic,
  importPackage,
  MAX_PACKAGE_EXPANDED_BYTES,
  sha256BytesHex,
  type DownloadTransport,
  type InstalledFile,
  type PackageArchive,
} from "./modelTransfers";

const encoder = new TextEncoder();

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "qwen3-0.6b-litert-dynamic-int4",
    displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
    category: "text",
    role: "chat-text",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    license: "apache-2.0",
    downloadBytes: 64,
    installedBytes: 64,
    sha256: null,
    minFreeRamMb: 1280,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "SUPPORTED_UNVERIFIED",
    description: "First text target.",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    upstreamFile: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
    ...overrides,
  };
}

/** Small deterministic fixtures (bytes, never real weights). */
function weightsBytes(): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) & 0xff;
  return out;
}

function tokenizerBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({ vocab: ["<pad>", "hello", "world"] }));
}

function installedFiles(): InstalledFile[] {
  return [
    { path: "weights/model.litertlm", bytes: weightsBytes() },
    { path: "tokenizer/vocab.json", bytes: tokenizerBytes() },
  ];
}

function verifiedEntry(): ModelCatalogueEntry {
  const weights = weightsBytes();
  return entry({
    downloadBytes: weights.length,
    installedBytes: weights.length,
    sha256: sha256BytesHex(weights),
  });
}

function fakeTransport(
  data: Uint8Array,
  options?: { failAfterBytes?: number; seenOffsets?: number[] },
): DownloadTransport {
  return {
    download: async (url, offset, onChunk) => {
      void url;
      options?.seenOffsets?.push(offset);
      if (offset > data.length) throw new Error("offset past end");
      let sent = offset;
      const chunkSize = 7;
      while (sent < data.length) {
        if (
          options?.failAfterBytes != null &&
          sent - offset >= options.failAfterBytes
        ) {
          throw new Error("simulated network drop");
        }
        const end = Math.min(sent + chunkSize, data.length);
        onChunk(data.slice(sent, end));
        sent = end;
      }
      return { totalBytes: data.length };
    },
  };
}

function memoryArchive(
  files: InstalledFile[],
  manifest: unknown,
  symlinks?: readonly string[],
): PackageArchive {
  const manifestBytes =
    manifest === null ? null : encoder.encode(JSON.stringify(manifest));
  const store = new Map<string, Uint8Array>();
  if (manifestBytes != null) store.set("manifest.json", manifestBytes);
  for (const file of files) store.set(file.path, file.bytes);
  return {
    entries: [
      ...(manifestBytes != null
        ? [{ path: "manifest.json", size: manifestBytes.length }]
        : []),
      ...files.map((file) => ({
        path: file.path,
        size: file.bytes.length,
        isSymlink: symlinks?.includes(file.path) ?? false,
      })),
    ],
    readEntry: (path) => {
      const bytes = store.get(path);
      if (bytes == null) throw new Error(`missing archive entry: ${path}`);
      return bytes;
    },
  };
}

function exportedArchive(
  forEntry: ModelCatalogueEntry,
  mutate?: (files: InstalledFile[], manifest: Record<string, unknown>) => void,
  extra?: InstalledFile[],
): { archive: PackageArchive; entry: ModelCatalogueEntry } {
  const exported = exportPackage(forEntry, installedFiles(), {
    createdAt: "2026-09-22T00:00:00.000Z",
  });
  if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
  const files = installedFiles();
  const manifest = JSON.parse(JSON.stringify(exported.manifest)) as Record<
    string,
    unknown
  >;
  mutate?.(files, manifest);
  return {
    archive: memoryArchive([...files, ...(extra ?? [])], manifest),
    entry: forEntry,
  };
}

describe("sha256BytesHex", () => {
  it("matches the NIST vector for 'abc'", () => {
    expect(sha256BytesHex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("findUnsafePathReason / hasDeniedMagic", () => {
  it("confines paths to the per-model sandbox", () => {
    expect(findUnsafePathReason("weights/model.litertlm")).toBeNull();
    expect(findUnsafePathReason("../evil")).not.toBeNull();
    expect(findUnsafePathReason("/abs/path")).not.toBeNull();
    expect(findUnsafePathReason("C:/win/path")).not.toBeNull();
    expect(findUnsafePathReason("a\\b")).not.toBeNull();
    expect(findUnsafePathReason("")).not.toBeNull();
  });

  it("sniffs ELF, MZ, and dex magics", () => {
    expect(hasDeniedMagic(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]))).toBe(
      true,
    );
    expect(hasDeniedMagic(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBe(true);
    expect(
      hasDeniedMagic(new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0x30])),
    ).toBe(true);
    expect(hasDeniedMagic(weightsBytes())).toBe(false);
    expect(hasDeniedMagic(tokenizerBytes())).toBe(false);
  });
});

describe("checkDownloadGate", () => {
  it("refuses catalogue-only reference listings", () => {
    const gate = checkDownloadGate(
      entry({ catalogOnly: true, sha256: "ab".repeat(32) }),
      { availableFreeRamMb: 99999, advancedConfirmed: true },
    );
    expect(gate).toEqual({
      allowed: false,
      code: "NOT_INSTALLABLE",
      reason: expect.any(String),
    });
  });

  it("refuses entries without a shipped hash pin", () => {
    const gate = checkDownloadGate(entry({ sha256: null }), {
      availableFreeRamMb: 3000,
      advancedConfirmed: true,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("MISSING_PIN");
  });

  it("blocks below-minimum without confirmation, allows with it", () => {
    const target = entry({ sha256: "ab".repeat(32) });
    const blocked = checkDownloadGate(target, {
      availableFreeRamMb: 1000,
      advancedConfirmed: false,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.code).toBe("NEEDS_ADVANCED_CONFIRM");
    expect(
      checkDownloadGate(target, {
        availableFreeRamMb: 1000,
        advancedConfirmed: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("allows a pinned entry with headroom and no confirmation", () => {
    expect(
      checkDownloadGate(entry({ sha256: "ab".repeat(32) }), {
        availableFreeRamMb: 3000,
        advancedConfirmed: false,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("downloadModel", () => {
  it("downloads, verifies, and reports monotonic progress", () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const seen: { receivedBytes: number; totalBytes: number | null }[] = [];
    return downloadModel(target, "https://example.invalid/model", fakeTransport(data), {
      availableFreeRamMb: 3000,
      advancedConfirmed: false,
      onProgress: (progress) => seen.push({ ...progress }),
    }).then((result) => {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bytes).toEqual(data);
        expect(result.totalBytes).toBe(data.length);
      }
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[seen.length - 1]).toEqual({
        receivedBytes: data.length,
        totalBytes: data.length,
      });
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!.receivedBytes).toBeGreaterThanOrEqual(
          seen[i - 1]!.receivedBytes,
        );
      }
    });
  });

  it("resumes after an interruption without re-fetching the prefix", async () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const seenOffsets: number[] = [];
    const first = await downloadModel(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { failAfterBytes: 10, seenOffsets }),
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected interruption");
    expect(first.code).toBe("TRANSPORT_ERROR");
    expect(first.receivedBytes).toBeGreaterThan(0);

    const received = data.slice(0, first.receivedBytes);
    const resumed = await downloadModel(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { seenOffsets }),
      {
        availableFreeRamMb: 3000,
        advancedConfirmed: false,
        resumeFrom: { received, totalBytes: data.length },
      },
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.bytes).toEqual(data);
    expect(seenOffsets).toContain(first.receivedBytes);
  });

  it("rejects tampered bytes against the shipped pin", async () => {
    const target = verifiedEntry();
    const tampered = weightsBytes();
    tampered[0] = (tampered[0]! + 1) & 0xff;
    const result = await downloadModel(
      target,
      "https://example.invalid/model",
      fakeTransport(tampered),
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(result).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
  });

  it("rejects byte counts that drift from the catalogue pin", async () => {
    const target = entry({
      downloadBytes: 7,
      sha256: sha256BytesHex(weightsBytes()),
    });
    const result = await downloadModel(
      target,
      "https://example.invalid/model",
      fakeTransport(weightsBytes()),
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(result).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
  });

  it("does not fetch when the gate blocks", async () => {
    let fetched = false;
    const transport: DownloadTransport = {
      download: async () => {
        fetched = true;
        return { totalBytes: 0 };
      },
    };
    const result = await downloadModel(
      entry({ catalogOnly: true, sha256: "ab".repeat(32) }),
      "https://example.invalid/model",
      transport,
      { availableFreeRamMb: 99999, advancedConfirmed: true },
    );
    expect(result).toMatchObject({ ok: false, code: "NOT_INSTALLABLE" });
    expect(fetched).toBe(false);
  });
});

describe("importPackage", () => {
  it("accepts an exported package round-trip", async () => {
    const target = verifiedEntry();
    const { archive } = exportedArchive(target);
    const result = await importPackage(target, archive);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.entryId).toBe(target.id);
      expect(result.manifest.packageVersion).toBe("1");
    }
  });

  it("verifies the whole-package hash against the shipped pin when supplied", async () => {
    const raw = encoder.encode("tiny-package-bytes");
    const pinned = entry({ sha256: sha256BytesHex(raw) });
    const { archive: pinnedArchive } = exportedArchive(pinned);
    expect(
      (await importPackage(pinned, pinnedArchive, { rawPackageBytes: raw })).ok,
    ).toBe(true);
    const bad = await importPackage(pinned, pinnedArchive, {
      rawPackageBytes: encoder.encode("different-bytes"),
    });
    expect(bad).toMatchObject({ ok: false, code: "WHOLE_HASH_MISMATCH" });
  });

  it("rejects a missing manifest", async () => {
    const result = await importPackage(
      verifiedEntry(),
      memoryArchive(installedFiles(), null),
    );
    expect(result).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("rejects a corrupt manifest and an entry-id mismatch", async () => {
    const target = verifiedEntry();
    const corrupt = await importPackage(
      target,
      memoryArchive(installedFiles(), { packageVersion: "1" }),
    );
    expect(corrupt).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });

    const other = entry({ id: "other-entry" });
    const { archive } = exportedArchive(target);
    expect(await importPackage(other, archive)).toMatchObject({
      ok: false,
      code: "ENTRY_MISMATCH",
    });
  });

  it("rejects denied suffixes and sniffed executable content", async () => {
    const target = verifiedEntry();
    const withSo = exportedArchive(target, (files, manifest) => {
      const payload: InstalledFile = {
        path: "weights/payload.so",
        bytes: encoder.encode("native"),
      };
      files.push(payload);
      (manifest["files"] as unknown[]).push({
        path: payload.path,
        bytes: payload.bytes.length,
        sha256: sha256BytesHex(payload.bytes),
        method: "STORE",
      });
    });
    expect(await importPackage(target, withSo.archive)).toMatchObject({
      ok: false,
      code: "DENIED_FILE",
    });

    const withElf = exportedArchive(target, (files, manifest) => {
      const payload: InstalledFile = {
        path: "tokenizer/vocab.json",
        bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]),
      };
      const index = files.findIndex((file) => file.path === payload.path);
      files[index] = payload;
      const listed = (manifest["files"] as Record<string, unknown>[]).find(
        (file) => file["path"] === payload.path,
      )!;
      listed["bytes"] = payload.bytes.length;
      listed["sha256"] = sha256BytesHex(payload.bytes);
    });
    expect(await importPackage(target, withElf.archive)).toMatchObject({
      ok: false,
      code: "DENIED_FILE",
    });
  });

  it("rejects traversal, absolute, and symlink paths", async () => {
    const target = verifiedEntry();
    for (const badPath of ["../evil.bin", "/abs/evil.bin"]) {
      const attempt = exportedArchive(target, (files, manifest) => {
        const payload: InstalledFile = {
          path: badPath,
          bytes: encoder.encode("x"),
        };
        files.push(payload);
        (manifest["files"] as unknown[]).push({
          path: payload.path,
          bytes: payload.bytes.length,
          sha256: sha256BytesHex(payload.bytes),
          method: "DEFLATE",
        });
      });
      expect(await importPackage(target, attempt.archive)).toMatchObject({
        ok: false,
        code: "UNSAFE_PATH",
      });
    }

    const exported = exportPackage(target, installedFiles(), {
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
    const linked = memoryArchive(
      installedFiles(),
      exported.manifest,
      ["weights/model.litertlm"],
    );
    expect(await importPackage(target, linked)).toMatchObject({
      ok: false,
      code: "UNSAFE_PATH",
    });
  });

  it("rejects unlisted extra files and tampered content", async () => {
    const target = verifiedEntry();
    const withExtra = exportedArchive(
      target,
      undefined,
      [{ path: "tokenizer/extra.json", bytes: encoder.encode("{}") }],
    );
    expect(await importPackage(target, withExtra.archive)).toMatchObject({
      ok: false,
      code: "EXTRA_FILE",
    });

    const tampered = exportedArchive(target, (files) => {
      const original = files[0]!.bytes;
      const flipped = original.slice();
      flipped[0] = (flipped[0]! + 1) & 0xff;
      files[0] = { path: files[0]!.path, bytes: flipped };
    });
    expect(await importPackage(target, tampered.archive)).toMatchObject({
      ok: false,
      code: "HASH_MISMATCH",
    });
  });

  it("rejects declared-vs-actual size lies and oversized packages", async () => {
    const target = verifiedEntry();
    const lie = exportedArchive(target, (_files, manifest) => {
      (manifest["files"] as Record<string, unknown>[])[0]!["bytes"] = 999999;
    });
    expect(await importPackage(target, lie.archive)).toMatchObject({
      ok: false,
      code: "SIZE_MISMATCH",
    });

    const huge = exportedArchive(target, (_files, manifest) => {
      (manifest["files"] as Record<string, unknown>[])[0]!["bytes"] =
        MAX_PACKAGE_EXPANDED_BYTES + 1;
    });
    expect(await importPackage(target, huge.archive)).toMatchObject({
      ok: false,
      code: "PACKAGE_TOO_LARGE",
    });
  });
});

describe("exportPackage", () => {
  it("builds a manifest with policy compression methods", () => {
    const target = verifiedEntry();
    const result = exportPackage(target, installedFiles(), {
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`export failed: ${result.reason}`);
    expect(result.manifest.entryId).toBe(target.id);
    expect(result.manifest.upstream.repo).toBe(target.upstreamRepo);
    const methods = new Map(
      result.manifest.files.map((file) => [file.path, file.method]),
    );
    expect(methods.get("weights/model.litertlm")).toBe("STORE");
    expect(methods.get("tokenizer/vocab.json")).toBe("DEFLATE");
    const paths = result.packageFiles.map((file) => file.path);
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("checksums.json");
    expect(JSON.parse(result.checksumsJson)).toMatchObject({
      entryId: target.id,
    });
  });

  it("refuses reference listings, empty input, and missing weights", () => {
    const target = verifiedEntry();
    expect(
      exportPackage(entry({ catalogOnly: true }), installedFiles()),
    ).toMatchObject({ ok: false, code: "NOT_INSTALLABLE" });
    expect(exportPackage(target, [])).toMatchObject({
      ok: false,
      code: "NO_FILES",
    });
    expect(
      exportPackage(target, [
        { path: "tokenizer/vocab.json", bytes: tokenizerBytes() },
      ]),
    ).toMatchObject({ ok: false, code: "MISSING_WEIGHTS" });
  });

  it("refuses executable content at export time", () => {
    const target = verifiedEntry();
    expect(
      exportPackage(target, [
        ...installedFiles(),
        { path: "weights/run.sh", bytes: encoder.encode("#!/bin/sh") },
      ]),
    ).toMatchObject({ ok: false, code: "DENIED_FILE" });
  });
});
