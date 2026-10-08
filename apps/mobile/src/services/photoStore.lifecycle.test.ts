// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearPhotoStore,
  getPhotoDescriptor,
  persistStashedPhotos,
  stashPhotoFile,
} from "./photoStore";

beforeEach(() => clearPhotoStore());
afterEach(() => {
  vi.restoreAllMocks();
  clearPhotoStore();
});

it("late photo-byte persistence cannot restore a published account's retired image", async () => {
  const id = stashPhotoFile(new File(["abc"], "old.jpg", { type: "image/jpeg" }), { accountId: "u1" });
  let finish: (() => void) | null = null;
  let release!: (value: ArrayBuffer) => void;
  const gate = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
  vi.spyOn(File.prototype, "arrayBuffer").mockImplementation(() => {
    finish = () => release(new Uint8Array([97, 98, 99]).buffer);
    return gate;
  });
  const pending = persistStashedPhotos("u1");
  expect(finish).not.toBeNull();
  clearPhotoStore("u1");
  finish!();
  await pending;

  expect(getPhotoDescriptor(id, "u1")).toBeNull();
});

it("sign-out invalidates in-flight persistence for every account", async () => {
  const id = stashPhotoFile(new File(["abc"], "old.jpg", { type: "image/jpeg" }), { accountId: "u1" });
  let finish: (() => void) | null = null;
  let release!: (value: ArrayBuffer) => void;
  const gate = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
  vi.spyOn(File.prototype, "arrayBuffer").mockImplementation(() => {
    finish = () => release(new Uint8Array([97, 98, 99]).buffer);
    return gate;
  });
  const pending = persistStashedPhotos("u1");
  expect(finish).not.toBeNull();
  clearPhotoStore();
  finish!();
  await pending;

  expect(getPhotoDescriptor(id, "u1")).toBeNull();
});

it("does not persist account A's live files to account B's registry", async () => {
  const id = stashPhotoFile(new File(["abc"], "alice.jpg", { type: "image/jpeg" }), { accountId: "u1" });
  await persistStashedPhotos("u2");
  expect(getPhotoDescriptor(id, "u2")).toBeNull();
});
