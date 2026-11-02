// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpcMock,
  getUserMock,
  uploadMock,
  removeMock,
  normalizeMock,
  clientMock,
} = vi.hoisted(() => {
  const rpcMock = vi.fn();
  const getUserMock = vi.fn();
  const uploadMock = vi.fn();
  const removeMock = vi.fn();
  const normalizeMock = vi.fn();
  const storageApi = {
    upload: (...args: unknown[]) => uploadMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  };
  const clientMock = {
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
    storage: { from: vi.fn(() => storageApi) },
    rpc: (...args: unknown[]) => rpcMock(...args),
  };
  return { rpcMock, getUserMock, uploadMock, removeMock, normalizeMock, clientMock };
});

// P11: staging/discard are RPCs. Every "did not create" assertion must name the
// create RPC rather than count all calls, or it would also forbid the discard.
const CREATE_RPCS = ["findback_create_post_client", "findback_create_post_client_multi"];
const createCalls = () =>
  rpcMock.mock.calls.filter(([name]) => CREATE_RPCS.includes(name as string));
const discardCalls = () =>
  rpcMock.mock.calls.filter(([name]) => name === "findback_discard_staged_upload");

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
  normalizeMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  uploadMock.mockResolvedValue({ error: null });
  removeMock.mockResolvedValue({ error: null });
  normalizeMock.mockImplementation(async (file: File) => ({
    blob: new Blob(["normalized"], { type: "image/jpeg" }),
    mimeType: file.type || "image/jpeg",
    width: 100,
    height: 100,
  }));
  rpcMock.mockImplementation(async (name: string) =>
    CREATE_RPCS.includes(name) ? { data: "post-new", error: null } : { error: null });
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
    expect(createCalls()).toHaveLength(0);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(discardCalls()).toHaveLength(1);
  });

  it("a single-photo publish stops before the create when the form is gone", async () => {
    await expect(publishReport(input, photo("p1.jpg"), undefined, () => false))
      .rejects.toMatchObject({ name: "UploadCancelledError" });
    expect(createCalls()).toHaveLength(0);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("a multi-photo publish stops before the create when the form is gone", async () => {
    await expect(publishReportWithPhotos(input, [photo("p1.jpg")], { isCurrent: () => false }))
      .rejects.toMatchObject({ name: "UploadCancelledError" });
    expect(createCalls()).toHaveLength(0);
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
    expect(createCalls()).toHaveLength(0);
    // Exactly this attempt's staged objects are removed (no orphans).
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(discardCalls()).toHaveLength(2);
    expect(seen).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });
});
