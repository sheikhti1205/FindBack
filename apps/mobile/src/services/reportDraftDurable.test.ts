// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { backing } = vi.hoisted(() => ({ backing: new Map<string, string>() }));

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

async function freshModules() {
  vi.resetModules();
  const draft = await import("./reportDraft");
  const photos = await import("./photoStore");
  return { draft, photos };
}

function tinyFile(name: string, body: string): File {
  return new File([body], name, { type: "image/jpeg" });
}

function seedText(photoIds: string[]) {
  return {
    type: "LOST" as const,
    title: "Lost camera",
    description: "a black camera lost near the north gate entrance",
    category: "Electronics" as const,
    eventDate: "2026-09-20",
    location: { label: "North gate", latitude: null, longitude: null },
    youtubeUrl: "",
    photoId: photoIds[0] ?? null,
    photoNativeUri: null,
    photoWebPath: null,
    photoFormat: null,
    photoIds,
  };
}

describe("durable per-account report draft (G15)", () => {
  beforeEach(() => {
    backing.clear();
    vi.resetModules();
  });

  it("5-photo kill/restart restores ids + order + bytes + text", async () => {
    const first = await freshModules();
    const ids: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      ids.push(first.photos.stashPhotoFile(tinyFile(`p${n}.jpg`, `bytes-${n}`)));
    }
    first.draft.saveDraft(seedText(ids), "u1");
    await first.photos.persistStashedPhotos("u1");

    // Kill: drop every module-level map (fresh imports = new process).
    const second = await freshModules();

    const restored = second.draft.loadDraft("u1");
    expect(restored?.title).toBe("Lost camera");
    expect(restored?.description).toBe("a black camera lost near the north gate entrance");
    expect(restored?.photoIds).toEqual(ids);

    const files = await second.photos.restoreStashedPhotos("u1");
    expect(files).toEqual(ids);
    for (let n = 1; n <= 5; n += 1) {
      const file = second.photos.getStashedPhoto(ids[n - 1]);
      expect(file?.name).toBe(`p${n}.jpg`);
      expect(await file?.text()).toBe(`bytes-${n}`);
    }
  });

  it("drafts and photos are isolated per account", async () => {
    const first = await freshModules();
    const id = first.photos.stashPhotoFile(tinyFile("mine.jpg", "mine"));
    first.draft.saveDraft(seedText([id]), "u1");
    await first.photos.persistStashedPhotos("u1");

    const second = await freshModules();
    expect(second.draft.loadDraft("u2")).toBeNull();
    expect(await second.photos.restoreStashedPhotos("u2")).toEqual([]);
    expect(second.photos.getStashedPhoto(id)).toBeNull();
  });

  it("orphans (no bytes, no native ref) are pruned on restore", async () => {
    const first = await freshModules();
    const good = first.photos.stashPhotoFile(tinyFile("good.jpg", "good"));
    // A >1.5MB web file persists metadata-only: unrestorable after restart.
    const big = first.photos.stashPhotoFile(
      new File([new Uint8Array(2_000_000)], "big.jpg", { type: "image/jpeg" }),
    );
    first.draft.saveDraft(seedText([good, big]), "u1");
    await first.photos.persistStashedPhotos("u1");

    const second = await freshModules();
    const files = await second.photos.restoreStashedPhotos("u1");
    expect(files).toEqual([good]);
    expect(second.photos.getStashedPhoto(big)).toBeNull();
    // Second restore is stable: the orphan stays gone.
    expect(await second.photos.restoreStashedPhotos("u1")).toEqual([good]);
  });

  it("native refs survive without bytes as pending restores (not orphans)", async () => {
    const first = await freshModules();
    const id = first.photos.stashPhotoFile(tinyFile("tiny.jpg", "x"), {
      picked: { nativeUri: "content://media/1", webPath: "content://media/1", format: "jpg" },
    });
    first.draft.saveDraft(seedText([id]), "u1");
    await first.photos.persistStashedPhotos("u1");
    // Simulate restart losing the in-memory File but keeping storage.
    const second = await freshModules();
    // Drop the persisted bytes to prove the native ref alone keeps the entry.
    for (const [key, value] of Array.from(backing.entries())) {
      if (key.includes("reportPhotos")) {
        const parsed = JSON.parse(value) as { id: string; dataUrl?: string }[];
        backing.set(
          key,
          JSON.stringify(parsed.map((e) => ({ ...e, dataUrl: undefined }))),
        );
      }
    }
    const files = await second.photos.restoreStashedPhotos("u1");
    expect(files).toEqual([]);
    expect(second.photos.pendingNativePhotoIds("u1")).toEqual([id]);
  });
});
