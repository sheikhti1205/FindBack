import { describe, expect, it } from "vitest";
import type { ModelCatalogueEntry } from "./catalogueTypes";
import {
  checkDownloadGate,
  downloadModelToStore,
  exportPackageStream,
  findUnsafePathReason,
  hasDeniedMagic,
  importPackageStream,
  MAX_PACKAGE_EXPANDED_BYTES,
  sha256BytesHex,
  type DownloadTransport,
  type InstalledFileReader,
  type PackageWriter,
  type StreamingArchive,
} from "./modelTransfers";
import { MemoryTransferStore } from "./transferStore";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function installedParts(): { path: string; bytes: Uint8Array }[] {
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

function chunkedStream(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let offset = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (offset >= bytes.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const end = Math.min(offset + chunkSize, bytes.length);
          const value = bytes.slice(offset, end);
          offset = end;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function memoryArchive(
  files: { path: string; bytes: Uint8Array }[],
  manifest: unknown,
  symlinks?: readonly string[],
  chunkSize = 7,
): StreamingArchive {
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
    openEntry: (path) => {
      const bytes = store.get(path);
      if (bytes == null) throw new Error(`missing archive entry: ${path}`);
      return chunkedStream(bytes, chunkSize);
    },
  };
}

class TestWriter implements PackageWriter {
  readonly files = new Map<string, Uint8Array[]>();
  readonly methods = new Map<string, string>();

  async writeFile(
    file: { path: string; method: "STORE" | "DEFLATE" },
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) parts.push(chunk.slice());
    this.files.set(file.path, parts);
    this.methods.set(file.path, file.method);
  }

  async discardFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  concat(path: string): Uint8Array {
    const parts = this.files.get(path) ?? [];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function testReader(
  files: { path: string; bytes: Uint8Array }[],
): InstalledFileReader {
  return {
    files: files.map((file) => ({ path: file.path, size: file.bytes.length })),
    openRead: (path) => {
      const found = files.find((file) => file.path === path);
      if (found == null) throw new Error(`missing installed file: ${path}`);
      return chunkedStream(found.bytes, 5);
    },
  };
}

async function exportedArchive(
  forEntry: ModelCatalogueEntry,
  mutate?: (
    files: { path: string; bytes: Uint8Array }[],
    manifest: Record<string, unknown>,
  ) => void,
  extra?: { path: string; bytes: Uint8Array }[],
): Promise<{ archive: StreamingArchive; entry: ModelCatalogueEntry }> {
  const writer = new TestWriter();
  const exported = await exportPackageStream(
    forEntry,
    testReader(installedParts()),
    writer,
    { createdAt: "2026-09-22T00:00:00.000Z" },
  );
  if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
  const files = installedParts();
  const manifest = JSON.parse(JSON.stringify(exported.manifest)) as Record<
    string,
    unknown
  >;
  mutate?.(files, manifest);
  return {
    archive: memoryArchive(
      [
        ...files,
        { path: "checksums.json", bytes: encoder.encode(exported.checksumsJson) },
        ...(extra ?? []),
      ],
      manifest,
    ),
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

describe("downloadModelToStore", () => {
  it("streams to the store, verifies, and reports monotonic progress", async () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const store = new MemoryTransferStore();
    const seen: { receivedBytes: number; totalBytes: number | null }[] = [];
    const result = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data),
      store,
      {
        availableFreeRamMb: 3000,
        advancedConfirmed: false,
        onProgress: (progress) => seen.push({ ...progress }),
      },
    );
    expect(result).toEqual({
      ok: true,
      installedBytes: data.length,
      totalBytes: data.length,
    });
    expect(store.installedBytes(target.id)).toBe(data.length);
    expect(store.tempBytes(target.id)).toBe(0);
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

  it("resumes after an interruption from the staged temp offset", async () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const store = new MemoryTransferStore();
    const seenOffsets: number[] = [];
    const first = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { failAfterBytes: 10, seenOffsets }),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected interruption");
    expect(first.code).toBe("TRANSPORT_ERROR");
    expect(first.receivedBytes).toBeGreaterThan(0);
    expect(store.installedBytes(target.id)).toBeNull();
    const staged = store.tempBytes(target.id);
    expect(staged).toBe(first.receivedBytes);

    const resumed = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { seenOffsets }),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(resumed).toEqual({
      ok: true,
      installedBytes: data.length,
      totalBytes: data.length,
    });
    expect(seenOffsets).toContain(staged);
  });

  it("restarts from zero when restart is requested", async () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const store = new MemoryTransferStore();
    const seenOffsets: number[] = [];
    const first = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { failAfterBytes: 10 }),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(first.ok).toBe(false);
    const resumed = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data, { seenOffsets }),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false, restart: true },
    );
    expect(resumed.ok).toBe(true);
    expect(seenOffsets).toEqual([0]);
  });

  it("rejects tampered bytes and discards the corrupt prefix", async () => {
    const target = verifiedEntry();
    const store = new MemoryTransferStore();
    const tampered = weightsBytes();
    tampered[0] = (tampered[0]! + 1) & 0xff;
    const result = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(tampered),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(result).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(store.installedBytes(target.id)).toBeNull();
    expect(store.tempBytes(target.id)).toBe(0);
  });

  it("rejects byte counts that drift from the catalogue pin", async () => {
    const target = entry({
      downloadBytes: 7,
      sha256: sha256BytesHex(weightsBytes()),
    });
    const store = new MemoryTransferStore();
    const result = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(weightsBytes()),
      store,
      { availableFreeRamMb: 3000, advancedConfirmed: false },
    );
    expect(result).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
    expect(store.tempBytes(target.id)).toBe(0);
  });

  it("rejects a changed artifact on resume via the expected total", async () => {
    const target = verifiedEntry();
    const store = new MemoryTransferStore();
    const result = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(weightsBytes()),
      store,
      {
        availableFreeRamMb: 3000,
        advancedConfirmed: false,
        expectedTotalBytes: weightsBytes().length + 1,
      },
    );
    expect(result).toMatchObject({ ok: false, code: "SIZE_MISMATCH" });
  });

  it("keeps the staged prefix on cancellation for a later resume", async () => {
    const target = verifiedEntry();
    const data = weightsBytes();
    const store = new MemoryTransferStore();
    let chunks = 0;
    const result = await downloadModelToStore(
      target,
      "https://example.invalid/model",
      fakeTransport(data),
      store,
      {
        availableFreeRamMb: 3000,
        advancedConfirmed: false,
        control: {
          isCancelled: () => {
            chunks++;
            return chunks > 2;
          },
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: "CANCELLED" });
    if (result.ok) throw new Error("expected cancellation");
    expect(result.receivedBytes).toBeGreaterThan(0);
    expect(store.tempBytes(target.id)).toBe(result.receivedBytes);
    expect(store.installedBytes(target.id)).toBeNull();
  });

  it("does not fetch when the gate blocks", async () => {
    let fetched = false;
    const transport: DownloadTransport = {
      download: async () => {
        fetched = true;
        return { totalBytes: 0 };
      },
    };
    const result = await downloadModelToStore(
      entry({ catalogOnly: true, sha256: "ab".repeat(32) }),
      "https://example.invalid/model",
      transport,
      new MemoryTransferStore(),
      { availableFreeRamMb: 99999, advancedConfirmed: true },
    );
    expect(result).toMatchObject({ ok: false, code: "NOT_INSTALLABLE" });
    expect(fetched).toBe(false);
  });
});

describe("importPackageStream", () => {
  it("accepts an exported package round-trip at any chunk split", async () => {
    const target = verifiedEntry();
    const { archive } = await exportedArchive(target);
    const result = await importPackageStream(target, archive);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.entryId).toBe(target.id);
      expect(result.manifest.packageVersion).toBe("1");
    }
    const single = memoryArchive(
      [
        ...installedParts(),
        {
          path: "checksums.json",
          bytes: await collect(archive.openEntry("checksums.json")),
        },
      ],
      JSON.parse(decoder.decode(await collect(archive.openEntry("manifest.json")))),
      undefined,
      1000,
    );
    expect((await importPackageStream(target, single)).ok).toBe(true);
  });

  it("verifies the whole-package hash against the shipped pin when supplied", async () => {
    const raw = encoder.encode("tiny-package-bytes");
    const pinned = entry({ sha256: sha256BytesHex(raw) });
    const { archive: pinnedArchive } = await exportedArchive(pinned);
    expect(
      (
        await importPackageStream(pinned, pinnedArchive, {
          rawPackageSha256: sha256BytesHex(raw),
        })
      ).ok,
    ).toBe(true);
    const bad = await importPackageStream(pinned, pinnedArchive, {
      rawPackageSha256: sha256BytesHex(encoder.encode("different-bytes")),
    });
    expect(bad).toMatchObject({ ok: false, code: "WHOLE_HASH_MISMATCH" });
  });

  it("rejects a missing manifest", async () => {
    const result = await importPackageStream(
      verifiedEntry(),
      memoryArchive(installedParts(), null),
    );
    expect(result).toMatchObject({ ok: false, code: "MANIFEST_MISSING" });
  });

  it("rejects a corrupt manifest and an entry-id mismatch", async () => {
    const target = verifiedEntry();
    const corrupt = await importPackageStream(
      target,
      memoryArchive(installedParts(), { packageVersion: "1" }),
    );
    expect(corrupt).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });

    const other = entry({ id: "other-entry" });
    const { archive } = await exportedArchive(target);
    expect(await importPackageStream(other, archive)).toMatchObject({
      ok: false,
      code: "ENTRY_MISMATCH",
    });
  });

  it("rejects denied suffixes and sniffed executable content", async () => {
    const target = verifiedEntry();
    const withSo = await exportedArchive(target, (files, manifest) => {
      const payload = { path: "weights/payload.so", bytes: encoder.encode("native") };
      files.push(payload);
      (manifest["files"] as unknown[]).push({
        path: payload.path,
        bytes: payload.bytes.length,
        sha256: sha256BytesHex(payload.bytes),
        method: "STORE",
      });
    });
    expect(await importPackageStream(target, withSo.archive)).toMatchObject({
      ok: false,
      code: "DENIED_FILE",
    });

    const withElf = await exportedArchive(target, (files, manifest) => {
      const payload = {
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
    expect(await importPackageStream(target, withElf.archive)).toMatchObject({
      ok: false,
      code: "DENIED_FILE",
    });
  });

  it("rejects traversal, absolute, and symlink paths", async () => {
    const target = verifiedEntry();
    for (const badPath of ["../evil.bin", "/abs/evil.bin"]) {
      const attempt = await exportedArchive(target, (files, manifest) => {
        const payload = { path: badPath, bytes: encoder.encode("x") };
        files.push(payload);
        (manifest["files"] as unknown[]).push({
          path: payload.path,
          bytes: payload.bytes.length,
          sha256: sha256BytesHex(payload.bytes),
          method: "DEFLATE",
        });
      });
      expect(await importPackageStream(target, attempt.archive)).toMatchObject({
        ok: false,
        code: "UNSAFE_PATH",
      });
    }

    const writer = new TestWriter();
    const exported = await exportPackageStream(
      target,
      testReader(installedParts()),
      writer,
      { createdAt: "2026-09-22T00:00:00.000Z" },
    );
    if (!exported.ok) throw new Error(`export failed: ${exported.reason}`);
    const linked = memoryArchive(
      [
        ...installedParts(),
        { path: "checksums.json", bytes: encoder.encode(exported.checksumsJson) },
      ],
      exported.manifest,
      ["weights/model.litertlm"],
    );
    expect(await importPackageStream(target, linked)).toMatchObject({
      ok: false,
      code: "UNSAFE_PATH",
    });
  });

  it("rejects unlisted extra files and tampered content", async () => {
    const target = verifiedEntry();
    const withExtra = await exportedArchive(
      target,
      undefined,
      [{ path: "tokenizer/extra.json", bytes: encoder.encode("{}") }],
    );
    expect(await importPackageStream(target, withExtra.archive)).toMatchObject({
      ok: false,
      code: "EXTRA_FILE",
    });

    const tampered = await exportedArchive(target, (files) => {
      const original = files[0]!.bytes;
      const flipped = original.slice();
      flipped[0] = (flipped[0]! + 1) & 0xff;
      files[0] = { path: files[0]!.path, bytes: flipped };
    });
    expect(await importPackageStream(target, tampered.archive)).toMatchObject({
      ok: false,
      code: "HASH_MISMATCH",
    });
  });

  it("rejects declared-vs-actual size lies and oversized packages", async () => {
    const target = verifiedEntry();
    const lie = await exportedArchive(target, (_files, manifest) => {
      (manifest["files"] as Record<string, unknown>[])[0]!["bytes"] = 999999;
    });
    expect(await importPackageStream(target, lie.archive)).toMatchObject({
      ok: false,
      code: "SIZE_MISMATCH",
    });

    const huge = await exportedArchive(target, (_files, manifest) => {
      (manifest["files"] as Record<string, unknown>[])[0]!["bytes"] =
        MAX_PACKAGE_EXPANDED_BYTES + 1;
    });
    expect(await importPackageStream(target, huge.archive)).toMatchObject({
      ok: false,
      code: "PACKAGE_TOO_LARGE",
    });
  });
});

describe("exportPackageStream", () => {
  it("streams files to the writer with policy compression methods", async () => {
    const target = verifiedEntry();
    const writer = new TestWriter();
    const result = await exportPackageStream(
      target,
      testReader(installedParts()),
      writer,
      { createdAt: "2026-09-22T00:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`export failed: ${result.reason}`);
    expect(result.manifest.entryId).toBe(target.id);
    expect(result.manifest.upstream.repo).toBe(target.upstreamRepo);
    const methods = new Map(
      result.manifest.files.map((file) => [file.path, file.method]),
    );
    expect(methods.get("weights/model.litertlm")).toBe("STORE");
    expect(methods.get("tokenizer/vocab.json")).toBe("DEFLATE");
    expect(methods.get("checksums.json")).toBe("DEFLATE");
    expect(writer.methods.get("weights/model.litertlm")).toBe("STORE");
    expect(writer.methods.get("tokenizer/vocab.json")).toBe("DEFLATE");
    const manifestJson = JSON.parse(decoder.decode(writer.concat("manifest.json")));
    expect(manifestJson).toMatchObject({ entryId: target.id });
    expect(JSON.parse(result.checksumsJson)).toMatchObject({
      entryId: target.id,
    });
    const roundTrip = await importPackageStream(
      target,
      writerArchive(writer),
    );
    expect(roundTrip.ok).toBe(true);
  });

  it("refuses reference listings, empty input, and missing weights", async () => {
    const target = verifiedEntry();
    const writer = new TestWriter();
    expect(
      await exportPackageStream(
        entry({ catalogOnly: true }),
        testReader(installedParts()),
        writer,
      ),
    ).toMatchObject({ ok: false, code: "NOT_INSTALLABLE" });
    expect(
      await exportPackageStream(target, testReader([]), writer),
    ).toMatchObject({
      ok: false,
      code: "NO_FILES",
    });
    expect(
      await exportPackageStream(
        target,
        testReader([{ path: "tokenizer/vocab.json", bytes: tokenizerBytes() }]),
        writer,
      ),
    ).toMatchObject({ ok: false, code: "MISSING_WEIGHTS" });
  });

  it("refuses executable content at export time", async () => {
    const target = verifiedEntry();
    const writer = new TestWriter();
    expect(
      await exportPackageStream(
        target,
        testReader([
          ...installedParts(),
          { path: "weights/run.sh", bytes: encoder.encode("#!/bin/sh") },
        ]),
        writer,
      ),
    ).toMatchObject({ ok: false, code: "DENIED_FILE" });

    const elfWriter = new TestWriter();
    expect(
      await exportPackageStream(
        target,
        testReader([
          { path: "weights/model.litertlm", bytes: weightsBytes() },
          {
            path: "tokenizer/vocab.json",
            bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]),
          },
        ]),
        elfWriter,
      ),
    ).toMatchObject({ ok: false, code: "DENIED_FILE" });
    expect(elfWriter.files.has("tokenizer/vocab.json")).toBe(false);
  });
});

function writerArchive(writer: TestWriter): StreamingArchive {
  const paths = [...writer.files.keys()];
  return {
    entries: paths.map((path) => ({ path, size: writer.concat(path).length })),
    openEntry: (path) => {
      const parts = writer.files.get(path);
      if (parts == null) throw new Error(`missing writer entry: ${path}`);
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              if (index >= parts.length) {
                return Promise.resolve({ done: true, value: undefined });
              }
              const value = parts[index++]!;
              return Promise.resolve({ done: false, value });
            },
          };
        },
      };
    },
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
