import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImage, uploadPhotos } from "./posts";

const { clientMock, uploadMock, removeMock, insertMock, normalizeMock, diagMock } = vi.hoisted(() => {
  const diagMock = vi.fn();
  const uploadMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
  const removeMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
  const insertMock = vi.fn(async (_payload: Record<string, unknown>) => ({
    error: null as { message?: string } | null,
  }));
  const storageApi = {
    upload: uploadMock,
    remove: removeMock,
    getPublicUrl: vi.fn(() => ({ data: { publicUrl: "https://cdn.test/findback-images/u/x.jpg" } })),
  };
  const clientMock = {
    auth: { getUser: vi.fn() },
    storage: { from: vi.fn(() => storageApi) },
    from: vi.fn(() => ({ insert: insertMock })),
  };
  const normalizeMock = vi.fn(async () => ({
    blob: new Blob(["normalized"], { type: "image/jpeg" }),
    mimeType: "image/jpeg",
    width: 100,
    height: 100,
  }));
  return { clientMock, uploadMock, removeMock, insertMock, normalizeMock, diagMock };
});

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("./image", () => ({ normalizeImage: normalizeMock }));
vi.mock("./diag", () => ({ diag: diagMock }));

beforeEach(() => {
  uploadMock.mockClear();
  removeMock.mockClear();
  insertMock.mockClear();
  normalizeMock.mockClear();
  diagMock.mockClear();
  clientMock.auth.getUser.mockReset();
  clientMock.auth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  uploadMock.mockResolvedValue({ error: null });
  insertMock.mockResolvedValue({ error: null });
});

describe("uploadImage", () => {
  it("uploads the normalized blob under the caller's folder and stages the row", async () => {
    const file = new File(["raw"], "photo.jpg", { type: "image/jpeg" });

    const stored = await uploadImage(file);

    expect(normalizeMock).toHaveBeenCalledWith(file);
    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/[0-9a-f-]{36}\.jpg$/),
      expect.any(Blob),
      { contentType: "image/jpeg", upsert: false },
    );
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
        file_url: "https://cdn.test/findback-images/u/x.jpg",
      }),
    );
    expect(stored).toMatchObject({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: 10,
      objectKey: expect.stringMatching(/^user-1\/[0-9a-f-]{36}\.jpg$/),
    });
  });

  it("removes the exact object when staging the uploads row fails", async () => {
    insertMock.mockResolvedValue({ error: { message: "rls denied" } });

    await expect(uploadImage(new File(["raw"], "p.png", { type: "image/png" }))).rejects.toThrow(
      "rls denied",
    );

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([expect.stringMatching(/^user-1\/[0-9a-f-]{36}\.jpg$/)]);
  });

  it("refuses to upload without a session", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(uploadImage(new File(["raw"], "p.jpg", { type: "image/jpeg" }))).rejects.toMatchObject({
      status: 401,
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("stages the normalized display dimensions with the row (CF-060 M1)", async () => {
    normalizeMock.mockResolvedValueOnce({
      blob: new Blob(["normalized"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 1234,
      height: 987,
    });

    const stored = await uploadImage(new File(["raw"], "wide.jpg", { type: "image/jpeg" }));

    // The feed lays out a natural-ratio grid from these values, so they must be
    // the dimensions of the blob that was actually stored — not the raw file's.
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1234, height: 987 }),
    );
    expect(stored).toMatchObject({ width: 1234, height: 987 });
  });

  it("stages no hint for a size it cannot vouch for (REVIEW-M1 F4)", async () => {
    // The pipeline deliberately passes large animated GIFs through untouched, so
    // a size outside the display-hint ceiling is publishable. The staging row
    // must carry no dimension rather than a value the database would reject:
    // a display hint may never decide whether a report can be published.
    normalizeMock.mockResolvedValueOnce({
      blob: new Blob(["normalized"], { type: "image/gif" }),
      mimeType: "image/gif",
      width: 200000,
      height: 400,
    });

    await uploadImage(new File(["raw"], "poster.gif", { type: "image/gif" }));

    const payload = insertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.width).toBeUndefined();
    expect(payload.height).toBeUndefined();
    // Everything the publish path actually needs is still staged.
    expect(payload.id).toBeTruthy();
    expect(payload.file_url).toBeTruthy();
  });

  it("stages no hint when the measured pair is half-known", async () => {
    normalizeMock.mockResolvedValueOnce({
      blob: new Blob(["normalized"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 1200,
      height: Number.NaN,
    });

    await uploadImage(new File(["raw"], "half.jpg", { type: "image/jpeg" }));

    const payload = insertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.width).toBeUndefined();
    expect(payload.height).toBeUndefined();
  });
});

describe("upload cancellation", () => {
  const file = (name = "photo.jpg") => new File(["raw"], name, { type: "image/jpeg" });

  it("stops waiting for a stalled storage upload instead of blocking on it", async () => {
    // The finding: Cancel during a hung upload did nothing until the request
    // resolved on its own, so the composer stayed busy indefinitely.
    uploadMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // Nothing was staged, so no row can claim an object that never landed.
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("removes the object when an abandoned upload lands after the abort", async () => {
    let resolveUpload: ((value: { error: null }) => void) | undefined;
    uploadMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // The request could not actually be cancelled; it finishes now.
    resolveUpload?.({ error: null });
    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledWith([expect.stringMatching(/^user-1\//)]));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("stops the batch at the file in flight and removes what it already staged", async () => {
    uploadMock
      .mockResolvedValueOnce({ error: null })
      .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const onProgress = vi.fn();

    const pending = uploadPhotos([file("a.jpg"), file("b.jpg")], {
      signal: controller.signal,
      onProgress,
    });
    // Both files have been attempted: the first staged, the second is stalled.
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(onProgress).toHaveBeenCalledTimes(1);
    // Exactly the one staged object is cleaned up.
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  // Contract test for the public API only. With the signal already aborted,
  // `uploadImage`'s own entry check rejects before anything happens, so this
  // passes even if the loop-level guard is deleted. The loop guard is in fact
  // redundant with that entry check: the batch test above exits through the
  // in-flight rejection and never reaches the loop head either. The guard is
  // kept as cheap defence in depth, not as the thing that enforces this.
  it("never starts staging when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadPhotos([file()], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe("storage failure", () => {
  it("reports a Storage error as a 502 and never stages a row", async () => {
    // N6 from review #1: the `{ error }` rewrite was verified by reading only.
    uploadMock.mockResolvedValue({ error: { message: "quota exceeded" } });

    await expect(uploadImage(new File(["raw"], "p.jpg", { type: "image/jpeg" }))).rejects.toMatchObject({
      message: "quota exceeded",
      status: 502,
    });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("cancellation coverage", () => {
  const file = (name = "photo.jpg") => new File(["raw"], name, { type: "image/jpeg" });

  it("passes the signal into normalization so a cancel can stop the decode", async () => {
    // The one line of the R1 fix that neither the suite nor the mutation set
    // defended: deleting `{ signal }` left every other test green.
    const controller = new AbortController();
    const target = file();

    await uploadImage(target, undefined, controller.signal);

    expect(normalizeMock).toHaveBeenCalledWith(target, undefined, { signal: controller.signal });
  });

  it("stops waiting for a stalled auth lookup", async () => {
    clientMock.auth.getUser.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(normalizeMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("diagnoses a cleanup that failed with { error } instead of orphaning silently", async () => {
    let resolveUpload: ((value: { error: null }) => void) | undefined;
    uploadMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    removeMock.mockResolvedValue({ error: { message: "403 storage policy" } });
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    resolveUpload?.({ error: null });
    await vi.waitFor(() =>
      expect(diagMock).toHaveBeenCalledWith(
        "posts.upload.abandoned_cleanup_error",
        expect.objectContaining({ message: "403 storage policy" }),
        expect.anything(),
      ),
    );
  });

  it("diagnoses a cleanup that throws synchronously before it can return a promise", async () => {
    // `storage.from()` can throw synchronously (uninitialised client, bad config).
    // That throw happens inside the late-cleanup callback, so without the outer
    // `.catch` it becomes an unhandled rejection and the object is orphaned.
    let resolveUpload: ((value: { error: null }) => void) | undefined;
    uploadMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    removeMock.mockImplementation(() => { throw new Error("storage client not initialised"); });
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    resolveUpload?.({ error: null });
    await vi.waitFor(() =>
      expect(diagMock).toHaveBeenCalledWith(
        "posts.upload.abandoned_cleanup_error",
        expect.objectContaining({ message: "storage client not initialised" }),
        expect.anything(),
      ),
    );
  });

  it("diagnoses a cleanup that threw instead of leaving an unhandled rejection", async () => {
    let resolveUpload: ((value: { error: null }) => void) | undefined;
    uploadMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    removeMock.mockRejectedValue(new Error("network down"));
    const controller = new AbortController();

    const pending = uploadImage(file(), undefined, controller.signal);
    await vi.waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    resolveUpload?.({ error: null });
    await vi.waitFor(() =>
      expect(diagMock).toHaveBeenCalledWith(
        "posts.upload.abandoned_cleanup_error",
        expect.objectContaining({ message: "network down" }),
        expect.anything(),
      ),
    );
  });
});
