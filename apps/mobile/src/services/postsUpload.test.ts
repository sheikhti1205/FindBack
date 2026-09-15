import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImage } from "./posts";

const { clientMock, uploadMock, removeMock, insertMock, normalizeMock } = vi.hoisted(() => {
  const uploadMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
  const removeMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
  const insertMock = vi.fn(async () => ({ error: null as { message?: string } | null }));
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
});
