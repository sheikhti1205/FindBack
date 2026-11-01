// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpcMock,
  getUserMock,
  uploadMock,
  removeMock,
  insertMock,
  uploadsDeleteEqMock,
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
    from: vi.fn(() => ({
      insert: (...args: unknown[]) => insertMock(...args),
      delete: () => ({ eq: (...args: unknown[]) => uploadsDeleteEqMock(...args) }),
    })),
    rpc: (...args: unknown[]) => rpcMock(...args),
  };
  return {
    rpcMock, getUserMock, uploadMock, removeMock, insertMock,
    uploadsDeleteEqMock, normalizeMock, clientMock,
  };
});

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("./image", () => ({ normalizeImage: (...args: unknown[]) => normalizeMock(...args) }));

import { publishReport, publishReportWithPhotos } from "./posts";

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

beforeEach(() => {
  rpcMock.mockReset();
  getUserMock.mockReset();
  uploadMock.mockReset();
  removeMock.mockReset();
  insertMock.mockReset();
  uploadsDeleteEqMock.mockReset();
  normalizeMock.mockReset();
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

describe("publish lifetime fence (F5)", () => {
  it.each(["single", "multi"])("does not create when the form leaves during deferred %s staging", async (mode) => {
    let finishUpload!: (value: { error: null }) => void;
    let started!: () => void;
    const uploading = new Promise<void>(resolve => { started = resolve; });
    uploadMock.mockImplementation(() => {
      started();
      return new Promise(resolve => { finishUpload = resolve; });
    });
    let current = true;
    const pending = mode === "single"
      ? publishReport(input, photo("late.jpg"), undefined, () => current)
      : publishReportWithPhotos(input, [photo("late.jpg")], { isCurrent: () => current });
    const assertion = expect(pending).rejects.toMatchObject({ name: "UploadCancelledError" });
    await uploading;
    current = false;
    finishUpload({ error: null });
    await assertion;
    expect(rpcMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(uploadsDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it("a single-photo publish stops before the create when the form is gone", async () => {
    await expect(publishReport(input, photo("p1.jpg"), undefined, () => false))
      .rejects.toMatchObject({ name: "UploadCancelledError" });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("a multi-photo publish stops before the create when the form is gone", async () => {
    await expect(publishReportWithPhotos(input, [photo("p1.jpg")], { isCurrent: () => false }))
      .rejects.toMatchObject({ name: "UploadCancelledError" });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

describe("publishReportWithPhotos cancellation boundary (P1)", () => {
  it("an abort after final staging must not create the post; staged uploads are cleaned", async () => {
    const controller = new AbortController();
    // Stage both photos, then abort strictly before the create RPC runs.
    const seen: Array<{ completed: number; total: number }> = [];
    uploadMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { error: null };
    });
    rpcMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { data: "post-new", error: null };
    });

    const pending = publishReportWithPhotos(input, [photo("p1.jpg"), photo("p2.jpg")], {
      signal: controller.signal,
      onProgress: (p) => {
        seen.push({ ...p });
        if (p.completed === 2 && p.total === 2) controller.abort();
      },
    });

    await expect(pending).rejects.toMatchObject({ name: "UploadCancelledError" });
    // Point of no return was never entered: no post row may exist.
    expect(rpcMock).not.toHaveBeenCalled();
    // Exactly this attempt's staged objects are removed (no orphans).
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(uploadsDeleteEqMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });
});
