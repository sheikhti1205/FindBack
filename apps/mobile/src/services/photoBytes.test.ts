// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { clearPhotoBytes, readPhotoBytes, writePhotoBytes } from "./photoBytes";

it("round-trips five multi-megabyte photos without storing base64 in localStorage", async () => {
  const account = crypto.randomUUID();
  const images = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, file: new File([new Uint8Array(2_000_000).fill(i + 1)], `${i}.jpg`, { type: "image/jpeg" }) }));
  await writePhotoBytes(account, images);
  for (const { id, file } of images) {
    const restored = await readPhotoBytes(account, id);
    expect(restored?.size).toBe(file.size);
    expect(new Uint8Array(await restored!.arrayBuffer())[0]).toBe(Number(id) + 1);
  }
  await clearPhotoBytes(account);
  expect(await readPhotoBytes(account, "0")).toBeNull();
});

it("restores all five large web photos from the report store after a fresh module load", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const ids = Array.from({ length: 5 }, (_, i) => store.stashPhotoFile(
    new File([new Uint8Array(2_000_000).fill(i + 1)], `web-${i}.jpg`, { type: "image/jpeg" }),
    { accountId: account },
  ));
  await store.persistStashedPhotos(account);
  expect(localStorage.getItem(`findback:reportPhotos:v1:${account}`)).not.toContain("data:");
  vi.resetModules();
  const restarted = await import("./photoStore");
  expect(await restarted.restoreStashedPhotos(account)).toEqual(ids);
  expect(ids.map((id) => restarted.getStashedPhoto(id)?.size)).toEqual(Array(5).fill(2_000_000));
  restarted.clearPhotoStore(account);
});

it("restores an 8MB gallery file after a draft restart without a native URI", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const file = new File([new Uint8Array(8 * 1024 * 1024).fill(73)], "large.jpg", { type: "image/jpeg" });
  const id = store.stashPhotoFile(file, { accountId: account });
  await store.persistStashedPhotos(account);
  expect(localStorage.getItem(`findback:reportPhotos:v1:${account}`)).not.toContain("data:");
  vi.resetModules();
  const restarted = await import("./photoStore");
  expect(await restarted.restoreStashedPhotos(account)).toEqual([id]);
  const restored = restarted.getStashedPhoto(id);
  expect(restored?.size).toBe(8 * 1024 * 1024);
  expect(new Uint8Array(await restored!.arrayBuffer())[0]).toBe(73);
  restarted.clearPhotoStore(account);
});

it("does not resurrect a removed photo when its earlier persist is still pending", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File(["private"], "p.jpg", { type: "image/jpeg" }), { accountId: account });
  const pending = store.persistStashedPhotos(account);
  store.dropStashedPhoto(id, account);
  await pending;
  await store.persistStashedPhotos(account);
  vi.resetModules();
  const restarted = await import("./photoStore");
  expect(await restarted.restoreStashedPhotos(account)).toEqual([]);
  expect(await readPhotoBytes(account, id)).toBeNull();
  restarted.clearPhotoStore(account);
});

it("does not resurrect signed-out photo bytes after a pending write", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File(["private"], "p.jpg", { type: "image/jpeg" }), { accountId: account });
  const pending = store.persistStashedPhotos(account);
  store.clearPhotoStore(account);
  await pending;
  expect(await readPhotoBytes(account, id)).toBeNull();
  vi.resetModules();
  const restarted = await import("./photoStore");
  expect(await restarted.restoreStashedPhotos(account)).toEqual([]);
});

it("global sign-out deletes photo bytes even if the localStorage account index was lost", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File(["private"], "p.jpg", { type: "image/jpeg" }), { accountId: account });
  await store.persistStashedPhotos(account);
  localStorage.removeItem("findback:reportPhotoAccounts:v1");
  store.clearPhotoStore();
  const activeBytes = await import("./photoBytes");
  expect(await activeBytes.readPhotoBytes(account, id)).toBeNull();
});

it("reports unavailable durable storage for a large gallery photo rather than claiming it was saved", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File([new Uint8Array(2_000_000)], "large.jpg", { type: "image/jpeg" }), { accountId: account });
  vi.stubGlobal("indexedDB", undefined);
  try {
    // Warning-only: resolves with durable:false (registry still written
    // metadata-only so restore prunes the orphan) instead of throwing.
    const report = await store.persistStashedPhotos(account);
    expect(report.durable).toBe(false);
    expect(report.warning).toMatch(/storage|save|retain/i);
    expect(store.getStashedPhoto(id)?.size).toBe(2_000_000);
    vi.resetModules();
    const restarted = await import("./photoStore");
    expect(await restarted.restoreStashedPhotos(account)).toEqual([]);
    expect(restarted.getStashedPhoto(id)).toBeNull();
    restarted.clearPhotoStore(account);
  } finally {
    vi.unstubAllGlobals();
    store.clearPhotoStore(account);
  }
});

it("reports descriptor write failure without dropping the live photo", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File(["photo"], "p.jpg", { type: "image/jpeg" }), { accountId: account });
  const original = Storage.prototype.setItem;
  const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith("findback:reportPhotos:")) throw new Error("storage blocked");
    original.call(this, key, value);
  });
  try {
    await expect(store.persistStashedPhotos(account)).rejects.toThrow(/storage|save/i);
    expect(store.getStashedPhoto(id)?.size).toBe(5);
  } finally {
    failed.mockRestore();
    store.clearPhotoStore(account);
  }
});

it("sign-out still clears photo bytes when localStorage removal throws", async () => {
  const account = crypto.randomUUID();
  const store = await import("./photoStore");
  const id = store.stashPhotoFile(new File(["private"], "p.jpg", { type: "image/jpeg" }), { accountId: account });
  await store.persistStashedPhotos(account);
  const failed = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  try {
    store.clearPhotoStore(account);
    const activeBytes = await import("./photoBytes");
    expect(await activeBytes.readPhotoBytes(account, id)).toBeNull();
  } finally {
    failed.mockRestore();
    store.clearPhotoStore(account);
  }
});

it("reads through the FileReader fallback deterministically when arrayBuffer is missing", async () => {
  const account = crypto.randomUUID();
  const file = new File(["abc"], "legacy.jpg", { type: "image/jpeg" });
  (file as unknown as Record<string, unknown>).arrayBuffer = undefined;
  class FakeReader {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: ArrayBuffer | null = null;
    readAsArrayBuffer(_blob: Blob) {
      queueMicrotask(() => {
        this.result = new TextEncoder().encode("abc").buffer as ArrayBuffer;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("FileReader", FakeReader);
  try {
    await writePhotoBytes(account, [{ id: "legacy", file }]);
    const restored = await readPhotoBytes(account, "legacy");
    expect(restored?.size).toBe(3);
    expect(new Uint8Array(await restored!.arrayBuffer())[0]).toBe(97);
  } finally {
    vi.unstubAllGlobals();
    await clearPhotoBytes(account);
  }
});

it("rejects with a typed error instead of hanging when no byte reader exists", async () => {
  const account = crypto.randomUUID();
  const file = new File(["abc"], "legacy.jpg", { type: "image/jpeg" });
  (file as unknown as Record<string, unknown>).arrayBuffer = undefined;
  vi.stubGlobal("FileReader", undefined);
  try {
    await expect(writePhotoBytes(account, [{ id: "legacy", file }])).rejects.toThrow(/unreadable file/);
  } finally {
    vi.unstubAllGlobals();
  }
});
