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
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    finish = () => {
      Object.defineProperty(this, "result", { configurable: true, value: "data:image/jpeg;base64,YWJj" });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    };
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
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    finish = () => {
      Object.defineProperty(this, "result", { configurable: true, value: "data:image/jpeg;base64,YWJj" });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    };
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
