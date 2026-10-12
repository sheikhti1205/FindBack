import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processReportBatch, createHashRegistry } from "./reportBatch";
import { photoToFile, type PhotoPipelineOpts, type PickedPhoto } from "../photo";

// L-CONSOLIDATE: the batch convert seam is required — the web lane passes
// its photoToFile bridge explicitly (exactly the old silent default, now
// visible at every call site).
function webConvert(photo: PickedPhoto, opts?: PhotoPipelineOpts): Promise<File> {
  return photoToFile(photo, undefined, opts);
}
const WEB_BATCH = { convert: webConvert };

// jsdom has no image decoder: reject normalization so the batch exercises the
// no-decoder fallback instead of hanging on a never-settling <img> decode.
const normalizeImageMock = vi.hoisted(() => vi.fn());
vi.mock("../image", () => ({ normalizeImage: normalizeImageMock }));

interface MockPhotoResult {
  photo: {
    id: string;
    nativeUri: string;
    webPath: string;
    format: string;
  };
  file: File;
}

// Helper to create a mock PickedPhoto with controllable file content.
// Emits a verifiable minimal JPEG (SOI + SOF0 1x1 + payload + EOI): the
// no-decoder fallback probes real headers, so headerless stubs are
// (correctly) rejected as damaged. The payload keeps hashes distinct.
function createMockPhoto(id: string, bytes: Uint8Array, format = "jpg"): MockPhotoResult {
  const sof0 = new Uint8Array([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]);
  const file = new File([new Uint8Array([255, 216]), sof0, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, new Uint8Array([255, 217])], `photo.${format}`, { type: `image/${format}` });
  const photo = {
    id,
    nativeUri: `file:///mock/${id}`,
    webPath: `blob:mock/${id}`,
    format,
  };
  return { photo, file };
}

// Mock fetch globally for photoToFile
const originalFetch = global.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  global.fetch = vi.fn();
  normalizeImageMock.mockReset();
  normalizeImageMock.mockRejectedValue(new Error("no decoder in this environment"));
});

afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function setupFetchMock(photoFileMap: Map<string, File>) {
  const mockFetch = vi.fn((url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const file = photoFileMap.get(urlString);
    if (file) {
      return Promise.resolve({
        ok: true,
        blob: () => Promise.resolve(file),
      } as unknown as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch for ${urlString}`));
  });
  global.fetch = mockFetch as typeof fetch;
}

describe("reportBatch", () => {
  describe("capacity math", () => {
    it("0/5 capacity accepts up to 5", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { photo, file } = createMockPhoto("p1", bytes);
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(1);
      expect(result.notice).toBe("1 photo added");
    });

    it("3/5 capacity accepts only 2 more", async () => {
      const photoFilePairs = [
        createMockPhoto("p1", new Uint8Array([1, 2, 3])),
        createMockPhoto("p2", new Uint8Array([4, 5, 6])),
        createMockPhoto("p3", new Uint8Array([7, 8, 9])),
      ];
      const photoFileMap = new Map<string, File>(photoFilePairs.map(({ photo, file }) => [photo.webPath, file] as [string, File]));
      setupFetchMock(photoFileMap);
      const photos = photoFilePairs.map(({ photo }) => photo);

      const result = await processReportBatch(photos, 3, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(2);
      expect(result.overflow.length).toBe(1);
      expect(result.unreadable).toHaveLength(0);
      expect(result.notice).toContain("2 photos added");
      expect(result.notice).toContain("1 over the 5 limit");
    });

    it("5/5 capacity accepts zero", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { photo, file } = createMockPhoto("p1", bytes);
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));

      const result = await processReportBatch([photo], 5, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(0);
      expect(result.overflow.length).toBe(1);
      expect(result.unreadable).toHaveLength(0);
      expect(result.notice).toBe("1 over the 5 limit");
    });
  });

  describe("fallback chooser returning 7 -> accept only remaining and report overflow", () => {
    it("when 0 selected and 7 picked, accepts 5 and reports 2 over the limit", async () => {
      const photoFilePairs = Array.from({ length: 7 }, (_, i) => createMockPhoto(`p${i}`, new Uint8Array([i + 1, i + 2, i + 3])));
      const photoFileMap = new Map<string, File>(photoFilePairs.map(({ photo, file }) => [photo.webPath, file] as [string, File]));
      setupFetchMock(photoFileMap);
      const photos = photoFilePairs.map(({ photo }) => photo);

      const result = await processReportBatch(photos, 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(5);
      expect(result.overflow.length).toBe(2);
      expect(result.unreadable).toHaveLength(0);
      expect(result.notice).toBe("5 photos added · 2 over the 5 limit");
    });

    it("when 3 selected and 7 picked, accepts 2 and reports 5 over the limit", async () => {
      const photoFilePairs = Array.from({ length: 7 }, (_, i) => createMockPhoto(`p${i}`, new Uint8Array([i + 1, i + 2, i + 3])));
      const photoFileMap = new Map<string, File>(photoFilePairs.map(({ photo, file }) => [photo.webPath, file] as [string, File]));
      setupFetchMock(photoFileMap);
      const photos = photoFilePairs.map(({ photo }) => photo);

      const result = await processReportBatch(photos, 3, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(2);
      expect(result.overflow.length).toBe(5);
      expect(result.unreadable).toHaveLength(0);
      expect(result.notice).toBe("2 photos added · 5 over the 5 limit");
    });
  });

  describe("duplicate detection", () => {
    it("same bytes twice in one batch -> 1 duplicate", async () => {
      const bytes = new Uint8Array([10, 20, 30, 40]);
      const { photo: photo1, file: file1 } = createMockPhoto("p1", bytes);
      const { photo: photo2, file: file2 } = createMockPhoto("p2", bytes); // same bytes, different id
      const photoFileMap = new Map<string, File>([
        [photo1.webPath, file1],
        [photo2.webPath, file2],
      ]);
      setupFetchMock(photoFileMap);

      const result = await processReportBatch([photo1, photo2], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(1);
      expect(result.duplicates.length).toBe(1);
      expect(result.notice).toBe("1 photo added · 1 already selected");
    });

    it("same bytes across batches -> duplicate (using shared registry)", async () => {
      const bytes = new Uint8Array([100, 200, 50]);
      const registry = createHashRegistry();

      // First batch
      const { photo: photo1, file: file1 } = createMockPhoto("p1", bytes);
      setupFetchMock(new Map<string, File>([[photo1.webPath, file1]]));
      const result1 = await processReportBatch([photo1], 0, registry, undefined, 0, WEB_BATCH);
      expect(result1.accepted.length).toBe(1);
      expect(result1.duplicates.length).toBe(0);

      // Second batch with same bytes
      const { photo: photo2, file: file2 } = createMockPhoto("p2", bytes);
      setupFetchMock(new Map<string, File>([[photo2.webPath, file2]]));
      const result2 = await processReportBatch([photo2], 1, registry, undefined, 0, WEB_BATCH);
      expect(result2.accepted.length).toBe(0);
      expect(result2.duplicates.length).toBe(1);
      expect(result2.notice).toBe("1 already selected");
    });

    it("same name different bytes -> both accepted", async () => {
      const bytes1 = new Uint8Array([1, 2, 3]);
      const bytes2 = new Uint8Array([4, 5, 6]);
      const { photo: photo1, file: file1 } = createMockPhoto("p1", bytes1);
      const { photo: photo2, file: file2 } = createMockPhoto("p2", bytes2); // different bytes
      const photoFileMap = new Map<string, File>([
        [photo1.webPath, file1],
        [photo2.webPath, file2],
      ]);
      setupFetchMock(photoFileMap);

      const result = await processReportBatch([photo1, photo2], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(2);
      expect(result.duplicates.length).toBe(0);
      expect(result.notice).toBe("2 photos added");
    });
  });

  describe("unreadable handling", () => {
    it("one unreadable among five -> other four survive with notice", async () => {
      const badBytes = new Uint8Array([4, 5, 6]);

      const goodPairs = Array.from({ length: 4 }, (_, i) => createMockPhoto(`good${i}`, new Uint8Array([i + 1, i + 2, i + 3])));
      const { photo: badPhoto, file: badFile } = createMockPhoto("bad", badBytes);

      const photoFileMap = new Map<string, File>([
        ...goodPairs.map(({ photo, file }) => [photo.webPath, file] as [string, File]),
        [badPhoto.webPath, badFile],
      ]);
      setupFetchMock(photoFileMap);

      // Make the bad photo fetch fail
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlString === badPhoto.webPath) {
          return Promise.reject(new Error("Network error"));
        }
        const file = photoFileMap.get(urlString);
        if (file) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(file),
          } as unknown as Response);
        }
        return Promise.reject(new Error(`Unexpected fetch for ${urlString}`));
      });
      global.fetch = mockFetch as typeof fetch;

      const allPhotos = [...goodPairs.map(({ photo }) => photo), badPhoto];
      const result = await processReportBatch(allPhotos, 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(4);
      expect(result.unreadable.length).toBe(1);
      expect(result.notice).toBe("4 photos added · 1 unreadable");
    });

    it("fetch failure produces unreadable with reason", async () => {
      const { photo, file } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      global.fetch = mockFetch as typeof fetch;

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(0);
      expect(result.unreadable.length).toBe(1);
      expect(result.unreadable[0]?.reason).toBe("Could not read the selected photo");
      expect(result.unreadable[0]?.index).toBe(0);
    });

    it("preserves the actionable HEIC failure and its selection position", async () => {
      // A Xiaomi HEIC the decoder refuses must surface the export-as-JPEG
      // guidance — not a generic "could not read" — labeled by position.
      const heic = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const { photo: photo1 } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      const heicPhoto = { id: "heic", nativeUri: "file:///mock/heic", webPath: "blob:mock/heic", format: "heic" };
      const heicFile = new File([heic], "photo.heic", { type: "image/heic" });
      const { photo: photo3 } = createMockPhoto("p3", new Uint8Array([7, 8, 9]));
      const good1 = new File([new Uint8Array([255, 216]), new Uint8Array([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]), new Uint8Array([1, 2, 3]), new Uint8Array([255, 217])], "photo.jpg", { type: "image/jpg" });
      const good3 = new File([new Uint8Array([255, 216]), new Uint8Array([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0]), new Uint8Array([7, 8, 9]), new Uint8Array([255, 217])], "photo.jpg", { type: "image/jpg" });
      const map = new Map<string, File>([
        ["blob:mock/p1", good1],
        ["blob:mock/heic", heicFile],
        ["blob:mock/p3", good3],
      ]);
      setupFetchMock(map);

      const result = await processReportBatch([photo1, heicPhoto, photo3], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(2);
      expect(result.unreadable.length).toBe(1);
      expect(result.unreadable[0]?.index).toBe(1);
      expect(result.unreadable[0]?.reason).toMatch(/export it as jpeg/i);
      // No native paths leak into the surfaced reason.
      expect(result.unreadable[0]?.reason).not.toMatch(/file:\/\/|content:\/\/|blob:/i);
    });

    it("offsets positions by the caller's index base", async () => {
      const { photo } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      setupFetchMock(new Map<string, File>([[photo.webPath, new File(["x"], "p.jpg", { type: "image/jpeg" })]]));
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as typeof fetch;

      const result = await processReportBatch([photo], 0, undefined, undefined, 2, WEB_BATCH);
      expect(result.unreadable.length).toBe(1);
      expect(result.unreadable[0]?.index).toBe(2);
    });

    it("hash computation failure produces unreadable", async () => {
      const { photo, file } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));

      // Mock crypto.subtle.digest to fail
      const originalDigest = crypto.subtle.digest;
      crypto.subtle.digest = vi.fn().mockRejectedValue(new Error("Digest failed"));

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(0);
      expect(result.unreadable.length).toBe(1);
      expect(result.unreadable[0]?.reason).toBe("Could not compute file hash");

      crypto.subtle.digest = originalDigest;
    });
  });

  describe("no silent truncation", () => {
    it("all accepted items preserved when one fails", async () => {
      const bytes1 = new Uint8Array([1, 2, 3]);
      const bytes2 = new Uint8Array([4, 5, 6]);
      const bytes3 = new Uint8Array([7, 8, 9]);

      const { photo: photo1, file: file1 } = createMockPhoto("p1", bytes1);
      const { photo: photo2, file: file2 } = createMockPhoto("p2", bytes2);
      const { photo: photo3, file: file3 } = createMockPhoto("p3", bytes3);

      const photoFileMap = new Map<string, File>([
        [photo1.webPath, file1],
        [photo2.webPath, file2],
        [photo3.webPath, file3],
      ]);
      setupFetchMock(photoFileMap);

      // Make photo2 fetch fail
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlString === photo2.webPath) return Promise.reject(new Error("Fail"));
        const file = photoFileMap.get(urlString);
        if (file) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(file),
          } as unknown as Response);
        }
        return Promise.reject(new Error(`Unexpected fetch for ${urlString}`));
      });
      global.fetch = mockFetch as typeof fetch;

      const result = await processReportBatch([photo1, photo2, photo3], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.accepted.length).toBe(2); // p1 and p3
      expect(result.unreadable.length).toBe(1); // p2
      expect(result.accepted.map((p) => p.id).sort()).toEqual(["p1", "p3"]);
    });
  });

  describe("injected convert seam (FBX-001)", () => {
    it("uses the provided converter and never falls back to fetching the photo webPath", async () => {
      const bytes = new Uint8Array([9, 8, 7]);
      const { photo, file } = createMockPhoto("p1", bytes);
      // A fetch would resolve for this webPath; the seam must make it unused.
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));
      const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
      const convert = vi.fn(async (_photo: { nativeUri: string }) => new File([new Uint8Array([1, 1, 1])], "native.jpg", { type: "image/jpeg" }));

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, { convert });
      expect(convert).toHaveBeenCalledTimes(1);
      expect(convert.mock.calls[0]?.[0]).toBe(photo);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.accepted.length).toBe(1);
      expect(result.unreadable).toHaveLength(0);
    });
    it("a converter rejection becomes an unreadable item with its position, not a thrown error", async () => {
      const { photo } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      const convert = vi.fn(async () => { throw new Error("Couldn't safely prepare this photo."); });
      const result = await processReportBatch([photo], 0, undefined, undefined, 0, { convert });
      expect(result.accepted).toHaveLength(0);
      expect(result.unreadable).toHaveLength(1);
      expect(result.unreadable[0]?.index).toBe(0);
      expect(result.unreadable[0]?.reason).toBe("Could not read the selected photo");
    });
    it("requires an explicit convert and fails fast without one", async () => {
      const { photo, file } = createMockPhoto("p1", new Uint8Array([3, 2, 1]));
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));
      await expect(processReportBatch([photo], 0)).rejects.toThrow(/explicit convert/i);
      await expect(
        processReportBatch([photo], 0, undefined, undefined, 0, {} as never),
      ).rejects.toThrow(/explicit convert/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("digest not logged", () => {
    it("hash is not exposed in notice or result structure", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { photo, file } = createMockPhoto("p1", bytes);
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, WEB_BATCH);
      const resultString = JSON.stringify(result);
      // Hash should not appear in notice or any result field
      expect(resultString).not.toMatch(/[a-f0-9]{64}/);
      expect(result.notice).not.toMatch(/[a-f0-9]{64}/);
    });
  });

  describe("notice string formatting", () => {
    it("omits zero clauses", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const { photo, file } = createMockPhoto("p1", bytes);
      setupFetchMock(new Map<string, File>([[photo.webPath, file]]));

      const result = await processReportBatch([photo], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.notice).toBe("1 photo added");
      expect(result.notice).not.toContain("already selected");
      expect(result.notice).not.toContain("unreadable");
    });

    it("pluralizes correctly", async () => {
      const { photo: photo1, file: file1 } = createMockPhoto("p1", new Uint8Array([1, 2, 3]));
      const { photo: photo2, file: file2 } = createMockPhoto("p2", new Uint8Array([4, 5, 6]));
      const photoFileMap = new Map<string, File>([
        [photo1.webPath, file1],
        [photo2.webPath, file2],
      ]);
      setupFetchMock(photoFileMap);

      const result = await processReportBatch([photo1, photo2], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.notice).toBe("2 photos added");
    });

    it("combines all three clauses", async () => {
      const bytes1 = new Uint8Array([1, 2, 3]);
      const bytes2 = new Uint8Array([1, 2, 3]); // duplicate
      const bytes3 = new Uint8Array([4, 5, 6]);

      const { photo: photo1, file: file1 } = createMockPhoto("p1", bytes1);
      const { photo: photo2, file: file2 } = createMockPhoto("p2", bytes2);
      const { photo: photo3, file: file3 } = createMockPhoto("p3", bytes3);

      const photoFileMap = new Map<string, File>([
        [photo1.webPath, file1],
        [photo2.webPath, file2],
        [photo3.webPath, file3],
      ]);
      setupFetchMock(photoFileMap);

      // Make photo3 fetch fail
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlString === photo3.webPath) return Promise.reject(new Error("Fail"));
        const file = photoFileMap.get(urlString);
        if (file) {
          return Promise.resolve({
            ok: true,
            blob: () => Promise.resolve(file),
          } as unknown as Response);
        }
        return Promise.reject(new Error(`Unexpected fetch for ${urlString}`));
      });
      global.fetch = mockFetch as typeof fetch;

      const result = await processReportBatch([photo1, photo2, photo3], 0, undefined, undefined, 0, WEB_BATCH);
      expect(result.notice).toBe("1 photo added · 1 already selected · 1 unreadable");
    });
  });
});
