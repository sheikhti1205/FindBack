// @vitest-environment jsdom
//
// FBX-030 (W2D-RECOVERY): the revive registry reopens persisted native refs
// ONLY through the canonical native processor (FindbackMedia
// importNativeImageUri). Kill/reboot restore is proven here at unit level
// (device matrix DEFERRED per OWNERSHIP R10); no test may pass through the
// legacy photoToFile conversion.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { backing, importNativeImageUri } = vi.hoisted(() => ({
  backing: new Map<string, string>(),
  importNativeImageUri: vi.fn(),
}));

vi.mock("./storage", () => ({
  storage: {
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  },
}));

vi.mock("./media/nativeMedia", () => ({
  importNativeImageUri,
  // Faithful copy of the production helper (pure): the real module registers
  // the Capacitor plugin at import time, which the test platform lacks.
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));

async function freshPhotos() {
  vi.resetModules();
  return import("./photoStore");
}

/** ImportedImage-shaped fixture: only the fields importedImageToFile touches. */
function imported(bytes: string, opts?: { motionStillUsed?: boolean }) {
  const data = new TextEncoder().encode(bytes);
  return {
    id: crypto.randomUUID(),
    fileName: "photo.jpg",
    motionStillUsed: opts?.motionStillUsed ?? false,
    derivative: { bytes: data, mimeType: "image/jpeg", byteLength: data.length, width: 8, height: 8, quality: 0.82 },
  };
}

function pickedRef(uri: string, format = "jpg") {
  return { nativeUri: uri, webPath: uri, format, id: `pick-${uri}` };
}

function descriptor(id: string, nativeUri: string, format: string) {
  return {
    id,
    name: `${id}.jpg`,
    type: "image/jpeg",
    size: 3,
    nativeUri,
    webPath: nativeUri,
    format,
    savedAt: 1,
  };
}

beforeEach(() => {
  backing.clear();
  importNativeImageUri.mockReset();
});

describe("revive registry through the canonical native processor (FBX-030)", () => {
  it("kill/reboot: a persisted HEIC ref with no durable bytes revives via importNativeImageUri", async () => {
    const first = await freshPhotos();
    const id = first.stashPhotoFile(new File(["orig"], "src.jpg", { type: "image/jpeg" }), {
      picked: pickedRef("content://media/heic-7", "heic"),
      accountId: "u1",
    });
    await first.persistStashedPhotos("u1");

    // Process death: in-memory Files are gone AND the durable byte payload is
    // lost (data URLs stripped) — only the registry's native ref survives.
    const second = await freshPhotos();
    for (const [key, value] of Array.from(backing.entries())) {
      if (key.includes("reportPhotos")) {
        const parsed = JSON.parse(value) as { id: string; dataUrl?: string }[];
        backing.set(key, JSON.stringify(parsed.map((e) => ({ ...e, dataUrl: undefined }))));
      }
    }
    expect(await second.restoreStashedPhotos("u1")).toEqual([]);
    expect(second.pendingNativePhotoIds("u1")).toEqual([id]);

    importNativeImageUri.mockResolvedValueOnce(imported("canonical-jpeg-bytes", { motionStillUsed: true }));
    const report = await second.reviveNativePhotos([{ id, picked: pickedRef("content://media/heic-7", "heic") }], {
      accountId: "u1",
    });

    expect(importNativeImageUri).toHaveBeenCalledTimes(1);
    expect(importNativeImageUri).toHaveBeenCalledWith("content://media/heic-7");
    expect(report).toEqual({ restored: [id], failed: [] });

    const file = second.getStashedPhoto(id);
    expect(file).toBeTruthy();
    expect(await file!.text()).toBe("canonical-jpeg-bytes");
    // The canonical processor returns the bounded JPEG derivative — never a
    // re-wrapped HEIC original (the legacy format/memory defect).
    expect(file!.type).toBe("image/jpeg");
    const picked = second.getStashedPhotoMeta(id)?.picked;
    expect(picked?.format).toBe("heic");
    expect(picked?.nativeUri).toBe("content://media/heic-7");
    expect(picked?.motionPhoto).toBe(true);
    expect(second.pendingNativePhotoIds("u1")).toEqual([]);
  });

  it("mixed outcome keeps request order and only opens granted content URIs", async () => {
    const photos = await freshPhotos();
    importNativeImageUri.mockImplementation(async (uri: string) => {
      if (uri === "content://a") return imported("bytes-a");
      throw new Error("processor failed");
    });

    const report = await photos.reviveNativePhotos(
      [
        { id: "slot-b", picked: pickedRef("content://b") },
        { id: "slot-a", picked: pickedRef("content://a") },
        { id: "slot-dead", picked: pickedRef("content://dead") },
        { id: "slot-raw", picked: pickedRef("file:///sdcard/raw.jpg") },
      ],
      { accountId: "u1" },
    );

    // Request order in both lists; the non-granted URI is named failed and
    // is never handed to any processor.
    expect(report).toEqual({ restored: ["slot-a"], failed: ["slot-b", "slot-dead", "slot-raw"] });
    expect(importNativeImageUri.mock.calls.map((c) => c[0])).toEqual([
      "content://b",
      "content://a",
      "content://dead",
    ]);
    expect(photos.getStashedPhoto("slot-a")).toBeTruthy();
    expect(await photos.getStashedPhoto("slot-a")!.text()).toBe("bytes-a");
    expect(photos.getStashedPhoto("slot-b")).toBeNull();
    expect(photos.getStashedPhoto("slot-raw")).toBeNull();
  });

  it("revival order follows the draft request order, not registry storage order", async () => {
    backing.set("findback:reportPhotos:v1:u1", JSON.stringify([
      descriptor("r1", "content://r1", "jpg"),
      descriptor("r2", "content://r2", "jpg"),
    ]));
    const photos = await freshPhotos();
    expect(await photos.restoreStashedPhotos("u1")).toEqual([]);
    expect(photos.pendingNativePhotoIds("u1")).toEqual(["r1", "r2"]);

    importNativeImageUri.mockImplementation(async (uri: string) => imported(`bytes-${uri.slice(-2)}`));
    const report = await photos.reviveNativePhotos(
      [
        { id: "r2", picked: pickedRef("content://r2") },
        { id: "r1", picked: pickedRef("content://r1") },
      ],
      { accountId: "u1" },
    );

    expect(importNativeImageUri.mock.calls.map((c) => c[0])).toEqual(["content://r2", "content://r1"]);
    expect(report).toEqual({ restored: ["r2", "r1"], failed: [] });
    expect(await photos.getStashedPhoto("r2")!.text()).toBe("bytes-r2");
    expect(await photos.getStashedPhoto("r1")!.text()).toBe("bytes-r1");
  });

  it("unreachable processor fails every slot into the Failed/Retry list with no fallback", async () => {
    const photos = await freshPhotos();
    // requireAndroid()'s rejection shape when FindbackMedia is unavailable.
    importNativeImageUri.mockRejectedValue(
      new Error("Native photo preparation is not available here."),
    );

    const report = await photos.reviveNativePhotos(
      [
        { id: "x1", picked: pickedRef("content://x1") },
        { id: "x2", picked: pickedRef("content://x2") },
      ],
      { accountId: "u1" },
    );

    expect(report).toEqual({ restored: [], failed: ["x1", "x2"] });
    expect(photos.getStashedPhoto("x1")).toBeNull();
    expect(photos.getStashedPhoto("x2")).toBeNull();
    expect(photos.getStashedPhotoMeta("x1")).toBeNull();
  });

  it("revive is idempotent for a stashed slot and stops between slots on cancel", async () => {
    const photos = await freshPhotos();
    const liveId = photos.stashPhotoFile(new File(["live"], "live.jpg", { type: "image/jpeg" }), {
      picked: pickedRef("content://live"),
      accountId: "u1",
    });

    importNativeImageUri.mockResolvedValueOnce(imported("first"));
    let checks = 0;
    const report = await photos.reviveNativePhotos(
      [
        { id: liveId, picked: pickedRef("content://live") },
        { id: "p1", picked: pickedRef("content://p1") },
        { id: "p2", picked: pickedRef("content://p2") },
      ],
      { accountId: "u1", isCancelled: () => checks++ >= 2 },
    );

    // liveId already holds a File (no re-import); p1 revived; p2 unstarted
    // after the cancel trips, so it is reported neither restored nor failed.
    expect(report).toEqual({ restored: [liveId, "p1"], failed: [] });
    expect(importNativeImageUri).toHaveBeenCalledTimes(1);
    expect(importNativeImageUri).toHaveBeenCalledWith("content://p1");
    expect(photos.getStashedPhoto("p2")).toBeNull();
  });

  it("photoStore contains no legacy photoToFile conversion call (static FBX-030 guard)", () => {
    // Vitest may run from the repo root or apps/mobile, and import.meta.url
    // is an http URL under jsdom — resolve by trial. A total miss throws.
    let src = "";
    for (const candidate of ["apps/mobile/src/services/photoStore.ts", "src/services/photoStore.ts"]) {
      try {
        src = readFileSync(candidate, "utf8");
        break;
      } catch {
        // Not under this cwd — try the next candidate.
      }
    }
    if (!src) throw new Error(`cannot locate photoStore.ts from cwd ${process.cwd()}`);
    expect(src).not.toMatch(/\bphotoToFile\s*\(/);
    expect(src).toContain("importNativeImageUri");
  });
});
