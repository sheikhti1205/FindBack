// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpcMock,
  getUserMock,
  uploadMock,
  removeMock,
  insertMock,
  uploadsDeleteEqMock,
  getPublicUrlMock,
  normalizeMock,
  clientMock,
} = vi.hoisted(() => {
  const rpcMock = vi.fn();
  const getUserMock = vi.fn();
  const uploadMock = vi.fn();
  const removeMock = vi.fn();
  const insertMock = vi.fn();
  const uploadsDeleteEqMock = vi.fn();
  const getPublicUrlMock = vi.fn((path: string) => ({
    data: { publicUrl: `https://cdn.test/storage/v1/object/public/findback-images/${path}` },
  }));
  const normalizeMock = vi.fn();
  const storageApi = {
    upload: (...args: unknown[]) => uploadMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
    getPublicUrl: (path: string) => getPublicUrlMock(path),
  };
  const clientMock = {
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
    storage: { from: vi.fn(() => storageApi) },
    from: vi.fn((table: string) => {
      if (table === "uploads") {
        return {
          insert: (...args: unknown[]) => insertMock(...args),
          delete: () => ({ eq: (...args: unknown[]) => uploadsDeleteEqMock(...args) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: (...args: unknown[]) => rpcMock(...args),
  };
  return {
    rpcMock,
    getUserMock,
    uploadMock,
    removeMock,
    insertMock,
    uploadsDeleteEqMock,
    getPublicUrlMock,
    normalizeMock,
    clientMock,
  };
});

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("./image", () => ({ normalizeImage: (...args: unknown[]) => normalizeMock(...args) }));

import {
  createPostMulti,
  mapAttachments,
  publishReportWithPhotos,
  uploadPhotos,
} from "./posts";

const input = {
  type: "LOST" as const,
  title: "Lost phone",
  description: "a black phone lost on campus",
  category: "Electronics" as const,
  eventDate: "2026-09-10",
};

function photo(name: string): File {
  return new File(["raw-bytes"], name, { type: "image/jpeg" });
}

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    post_id: "p1",
    file_url: "https://cdn.test/storage/v1/object/public/findback-images/user-1/a1.jpg",
    mime_type: "image/jpeg",
    file_name: "a1.jpg",
    file_size: 12,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function postRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    user_id: "u1",
    type: "LOST",
    title: "Lost phone",
    description: "a black phone lost on campus",
    category: "Electronics",
    status: "OPEN",
    event_date: "2026-09-01",
    latitude: null,
    longitude: null,
    location_label: null,
    youtube_url: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    author_username: "alice",
    author_email_verified: 1,
    author_phone_verified: 0,
    author_avatar_url: null,
    author_created_at: "2026-01-01T00:00:00.000Z",
    like_count: 0,
    dislike_count: 0,
    rating_avg: null,
    rating_count: 0,
    comment_count: 0,
    attachments: [
      attachmentRow({ id: "a1", display_order: 1 }),
      attachmentRow({
        id: "a2",
        file_url: "https://cdn.test/storage/v1/object/public/findback-images/user-1/a2.jpg",
        file_name: "a2.jpg",
        display_order: 2,
      }),
    ],
    total_count: 1,
    ...overrides,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  getUserMock.mockReset();
  uploadMock.mockReset();
  removeMock.mockReset();
  insertMock.mockReset();
  uploadsDeleteEqMock.mockReset();
  getPublicUrlMock.mockClear();
  normalizeMock.mockReset();
  clientMock.from.mockClear();
  (clientMock.storage.from as ReturnType<typeof vi.fn>).mockClear?.();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  uploadMock.mockResolvedValue({ error: null });
  removeMock.mockResolvedValue({ error: null });
  insertMock.mockResolvedValue({ error: null });
  uploadsDeleteEqMock.mockResolvedValue({ error: null });
  normalizeMock.mockImplementation(async (file: File) => ({
    blob: new Blob(["normalized"], { type: "image/jpeg" }),
    mimeType: file.type || "image/jpeg",
    width: 100,
    height: 100,
  }));
  rpcMock.mockResolvedValue({ data: "post-new", error: null });
});

describe("publishReportWithPhotos", () => {
  it("uploads each photo independently and calls the multi RPC with ordered keys", async () => {
    const id = await publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg"), photo("p3.jpg")]);

    expect(id).toBe("post-new");
    expect(uploadMock).toHaveBeenCalledTimes(3);
    expect(insertMock).toHaveBeenCalledTimes(3);
    const stagedIds = insertMock.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(rpcMock).toHaveBeenCalledWith(
      "findback_create_post_client_multi",
      expect.objectContaining({ p_attachment_keys: stagedIds }),
    );
    expect(stagedIds).toHaveLength(3);
    expect(new Set(stagedIds).size).toBe(3);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("reports per-upload progress in order", async () => {
    const progress: Array<{ completed: number; total: number }> = [];
    await publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg"), photo("p3.jpg")], {
      onProgress: (p: { completed: number; total: number }) => progress.push({ ...p }),
    });

    expect(progress).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it("a 3rd-of-5 upload failure creates no post and cleans exactly the two staged objects", async () => {
    normalizeMock.mockImplementation(async (file: File) => {
      if (file.name === "p3.jpg") throw new Error("network blew up mid-batch");
      return {
        blob: new Blob(["normalized"], { type: "image/jpeg" }),
        mimeType: "image/jpeg",
        width: 100,
        height: 100,
      };
    });

    await expect(
      publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg"), photo("p3.jpg"), photo("p4.jpg"), photo("p5.jpg")]),
    ).rejects.toThrow("network blew up mid-batch");

    // No ghost post: the create RPC is never reached when staging is incomplete.
    expect(rpcMock).not.toHaveBeenCalled();
    // Exactly the two staged objects of the aborted attempt are cleaned up.
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(uploadsDeleteEqMock).toHaveBeenCalledTimes(2);
    const stagedIds = insertMock.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(stagedIds).toHaveLength(2);
  });

  it("a create failure after full staging leaves no ghost post staged (all cleaned)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "create blew up", code: "400" } });

    await expect(publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg")])).rejects.toThrow(
      "create blew up",
    );

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(uploadsDeleteEqMock).toHaveBeenCalledTimes(2);
  });

  it("a lost create response preserves potentially committed photo bytes for reconciliation", async () => {
    rpcMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg")]))
      .rejects.toThrow(/publication.*uncertain/i);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(uploadsDeleteEqMock).not.toHaveBeenCalled();
  });

  it("a missing post id does not confirm publication or delete staged media", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    await expect(publishReportWithPhotos(input, [photo("p1.jpg")]))
      .rejects.toThrow(/publication.*uncertain/i);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("0 photos uses the legacy single-key path with a null key (old readers unaffected)", async () => {
    const id = await publishReportWithPhotos(input, []);

    expect(id).toBe("post-new");
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(
      "findback_create_post_client",
      expect.objectContaining({ p_attachment_key: null }),
    );
  });

  it("rejects 6 photos client-side before any upload or RPC", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((n) => photo(`${n}.jpg`));

    await expect(publishReportWithPhotos(input, six)).rejects.toThrow(/up to 5 photos/i);

    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("uploadPhotos", () => {
  it("returns staged uploads in input order", async () => {
    const stored = await uploadPhotos([photo("p1.jpg"), photo("p2.jpg")]);

    expect(stored).toHaveLength(2);
    expect(stored[0]!.fileName).toBe("p1.jpg");
    expect(stored[1]!.fileName).toBe("p2.jpg");
  });

  it("cleans staged objects of the aborted attempt when a later upload fails", async () => {
    normalizeMock.mockImplementation(async (file: File) => {
      if (file.name === "late.jpg") throw new Error("late failure");
      return {
        blob: new Blob(["normalized"], { type: "image/jpeg" }),
        mimeType: "image/jpeg",
        width: 100,
        height: 100,
      };
    });

    await expect(uploadPhotos([photo("early.jpg"), photo("late.jpg")])).rejects.toThrow("late failure");
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(uploadsDeleteEqMock).toHaveBeenCalledTimes(1);
  });
});

describe("createPostMulti", () => {
  it("calls the versioned multi RPC with ordered keys and returns the new id", async () => {
    const id = await createPostMulti({ ...input, attachmentKeys: ["u1", "u2", "u3"] });

    expect(id).toBe("post-new");
    expect(rpcMock).toHaveBeenCalledWith(
      "findback_create_post_client_multi",
      expect.objectContaining({
        p_type: "LOST",
        p_attachment_keys: ["u1", "u2", "u3"],
      }),
    );
  });

  it("rejects more than 5 keys before any RPC", async () => {
    await expect(
      createPostMulti({ ...input, attachmentKeys: ["a", "b", "c", "d", "e", "f"] }),
    ).rejects.toThrow(/at most 5/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys before any RPC", async () => {
    await expect(createPostMulti({ ...input, attachmentKeys: ["a", "a"] })).rejects.toThrow(/duplicate/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("mapAttachments display_order", () => {
  it("honours display_order from the row payload (explicit order, exact Attachment shape)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        postRow({
          attachments: [
            attachmentRow({ id: "third", display_order: 3 }),
            attachmentRow({ id: "first", display_order: 1 }),
            attachmentRow({ id: "second", display_order: 2 }),
          ],
        }),
      ],
      error: null,
    });
    rpcMock.mockImplementation(rpc);

    const { fetchPost } = await import("./posts");
    const post = await fetchPost("p1");

    expect(post.attachments.map((a) => a.id)).toEqual(["first", "second", "third"]);
    expect(post.attachments[0]).toEqual({
      id: "first",
      postId: "p1",
      fileUrl: "https://cdn.test/storage/v1/object/public/findback-images/user-1/a1.jpg",
      mimeType: "image/jpeg",
      fileName: "a1.jpg",
      fileSize: 12,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("keeps legacy input order when rows carry no display_order", () => {
    const rows = [
      { ...attachmentRow({ id: "x" }), display_order: undefined },
      { ...attachmentRow({ id: "y" }), display_order: undefined },
    ];
    delete (rows[0] as Record<string, unknown>).display_order;
    delete (rows[1] as Record<string, unknown>).display_order;

    expect(mapAttachments(rows as never).map((a: { id: string }) => a.id)).toEqual(["x", "y"]);
  });
});

