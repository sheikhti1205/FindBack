import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processReportBatch } from "./reportBatch";
import { photoToFile, type PhotoPipelineOpts, type PickedPhoto } from "../photo";

// L-CONSOLIDATE: the batch convert seam is required — the web lane passes
// its photoToFile bridge explicitly (exactly the old silent default, now
// visible at every call site).
function webConvert(photo: PickedPhoto, opts?: PhotoPipelineOpts): Promise<File> {
  return photoToFile(photo, undefined, opts);
}

// jsdom has no image decoder: reject normalization so the batch exercises the
// no-decoder fallback instead of hanging on a never-settling <img> decode.
const normalizeImageMock = vi.hoisted(() => vi.fn());
vi.mock("../image", () => ({ normalizeImage: normalizeImageMock }));

function createMockPhoto(id: string, bytes: Uint8Array, format = "jpg"): {
  photo: { id: string; nativeUri: string; webPath: string; format: string };
  file: File;
} {
  const sof0 = new Uint8Array([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]);
  const file = new File(
    [
      new Uint8Array([255, 216]),
      sof0,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      new Uint8Array([255, 217]),
    ],
    `photo.${format}`,
    { type: `image/${format}` },
  );
  const photo = { id, nativeUri: `file:///mock/${id}`, webPath: `blob:mock/${id}`, format };
  return { photo, file };
}

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn() as typeof fetch;
  normalizeImageMock.mockReset();
  normalizeImageMock.mockRejectedValue(new Error("no decoder in this environment"));
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function setupFetchMock(photoFileMap: Map<string, File>): void {
  const mockFetch = vi.fn((url: string | URL | Request) => {
    const urlString =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const file = photoFileMap.get(urlString);
    if (file) {
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(file) } as unknown as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch for ${urlString}`));
  });
  global.fetch = mockFetch as typeof fetch;
}

describe("processReportBatch progress + cancellation (Lane C)", () => {
  it("reports per-photo progress with done/total/currentName", async () => {
    const pairs = [
      createMockPhoto("p1", new Uint8Array([1, 2, 3])),
      createMockPhoto("p2", new Uint8Array([4, 5, 6])),
      createMockPhoto("p3", new Uint8Array([7, 8, 9])),
    ];
    setupFetchMock(new Map(pairs.map(({ photo, file }) => [photo.webPath, file] as [string, File])));
    const seen: Array<{ done: number; total: number; currentName: string }> = [];

    const result = await processReportBatch(
      pairs.map(({ photo }) => photo),
      0,
      undefined,
      undefined,
      0,
      { convert: webConvert, onProgress: (p) => seen.push({ ...p }) },
    );

    expect(result.accepted.length).toBe(3);
    expect(result.cancelled).toBe(false);
    expect(seen).toEqual([
      { done: 1, total: 3, currentName: "Photo 1" },
      { done: 2, total: 3, currentName: "Photo 2" },
      { done: 3, total: 3, currentName: "Photo 3" },
    ]);
  });

  it("an already-aborted signal accepts nothing and reports cancelled", async () => {
    const { photo, file } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
    setupFetchMock(new Map([[photo.webPath, file]]));
    const seen: unknown[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await processReportBatch([photo], 0, undefined, undefined, 0, {
      convert: webConvert,
      signal: controller.signal,
      onProgress: (p) => seen.push(p),
    });

    expect(result.accepted.length).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(seen).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("aborting after the first photo keeps it and stops the rest", async () => {
    const pairs = [
      createMockPhoto("p1", new Uint8Array([1, 2, 3])),
      createMockPhoto("p2", new Uint8Array([4, 5, 6])),
      createMockPhoto("p3", new Uint8Array([7, 8, 9])),
    ];
    setupFetchMock(new Map(pairs.map(({ photo, file }) => [photo.webPath, file] as [string, File])));
    const controller = new AbortController();
    const seen: Array<{ done: number; total: number }> = [];
    const acceptedIds: string[] = [];

    const result = await processReportBatch(
      pairs.map(({ photo }) => photo),
      0,
      undefined,
      (item) => {
        acceptedIds.push(item.id);
      },
      0,
      {
        convert: webConvert,
        signal: controller.signal,
        onProgress: (p) => {
          seen.push({ done: p.done, total: p.total });
          if (p.done === 1) controller.abort();
        },
      },
    );

    // Already-accepted tiles stay; pending ones stop.
    expect(acceptedIds).toEqual(["p1"]);
    expect(result.accepted.map((p) => p.id)).toEqual(["p1"]);
    expect(result.cancelled).toBe(true);
    expect(seen).toEqual([{ done: 1, total: 3 }]);
  });

  it("overflow items still advance progress", async () => {
    const pairs = [
      createMockPhoto("p1", new Uint8Array([1, 2, 3])),
      createMockPhoto("p2", new Uint8Array([4, 5, 6])),
      createMockPhoto("p3", new Uint8Array([7, 8, 9])),
    ];
    setupFetchMock(new Map(pairs.map(({ photo, file }) => [photo.webPath, file] as [string, File])));
    const seen: number[] = [];

    // 4/5 capacity: one slot, two overflow.
    const result = await processReportBatch(
      pairs.map(({ photo }) => photo),
      4,
      undefined,
      undefined,
      0,
      { convert: webConvert, onProgress: (p) => seen.push(p.done) },
    );

    expect(result.accepted.length).toBe(1);
    expect(result.overflow.length).toBe(2);
    expect(result.cancelled).toBe(false);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("fails fast without an explicit convert instead of running deaf", async () => {
    const { photo, file } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
    setupFetchMock(new Map([[photo.webPath, file]]));

    await expect(processReportBatch([photo], 0)).rejects.toThrow(/explicit convert/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("aborts in-flight decode (photoToFile) when the signal fires mid-fetch", async () => {
    const { photo } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
    // Hanging fetch that ONLY settles via the threaded AbortSignal: if
    // processReportBatch forgets {signal}, this never settles (stall).
    global.fetch = (vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown) as typeof fetch;
    const controller = new AbortController();
    const pending = processReportBatch([photo], 0, undefined, undefined, 0, {
      convert: webConvert,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const raced = await Promise.race([
      pending.then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false as const }), 800),
      ),
    ]);
    expect(raced.settled).toBe(true);
    if (raced.settled) {
      expect(raced.result.cancelled).toBe(true);
      expect(raced.result.accepted).toHaveLength(0);
    }
  }, 5000);

  it("aborts in-flight hash (computeSha256Hex) when the signal fires mid-digest", async () => {
    const { photo, file } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
    setupFetchMock(new Map([[photo.webPath, file]]));
    // Hanging digest: withTimeout's abort race only exists when the signal
    // is threaded into computeSha256Hex; otherwise this stalls to timeout.
    const originalDigest = crypto.subtle.digest;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      () => new Promise<ArrayBuffer>(() => {}),
    );
    try {
      const controller = new AbortController();
      const pending = processReportBatch([photo], 0, undefined, undefined, 0, {
        convert: webConvert,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      const raced = await Promise.race([
        pending.then((result) => ({ settled: true as const, result })),
        new Promise<{ settled: false }>((resolve) =>
          setTimeout(() => resolve({ settled: false as const }), 800),
        ),
      ]);
      expect(raced.settled).toBe(true);
      if (raced.settled) {
        expect(raced.result.cancelled).toBe(true);
        expect(raced.result.accepted).toHaveLength(0);
      }
    } finally {
      crypto.subtle.digest = originalDigest;
    }
  }, 5000);
});
