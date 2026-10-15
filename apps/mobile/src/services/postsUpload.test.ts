import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImage } from "./posts";

const { clientMock, uploadMock, removeMock, insertMock, normalizeMock } = vi.hoisted(() => {
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
  return { clientMock, uploadMock, removeMock, insertMock, normalizeMock };
});

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("./image", () => ({ normalizeImage: normalizeMock }));

beforeEach(() => {
  uploadMock.mockClear();
  removeMock.mockClear();
  insertMock.mockClear();
  normalizeMock.mockClear();
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
