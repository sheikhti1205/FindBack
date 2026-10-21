import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteNotifications,
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  markNotificationsUnread,
  restoreNotifications,
} from "./notifications";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "n1",
    type: "LIKE",
    preview: "Lost wallet",
    read: 0,
    created_at: "2026-09-20T00:00:00.000Z",
    actor_id: "u2",
    actor_username: "bob",
    post_id: "p1",
    post_title: "Lost wallet",
    comment_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  clientMock.rpc.mockReset();
});

describe("fetchNotifications", () => {
  it("reads the inbox via the client RPC and maps rows to camelCase", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row(), row({ id: "n2", type: "MENTION", read: 1 })], error: null });

    const items = await fetchNotifications();

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_list_notifications_client", {
      p_deleted: false,
    });
    expect(items).toEqual([
      {
        id: "n1",
        type: "LIKE",
        preview: "Lost wallet",
        read: false,
        createdAt: "2026-09-20T00:00:00.000Z",
        actorId: "u2",
        actorUsername: "bob",
        postId: "p1",
        postTitle: "Lost wallet",
        commentId: null,
        reactionKind: null,
      },
      expect.objectContaining({ id: "n2", type: "MENTION", read: true }),
    ]);
  });

  it("returns an empty inbox without error", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchNotifications()).toEqual([]);
  });

  it("maps a system STATUS row with a null actor", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        row({
          id: "n9",
          type: "STATUS",
          preview: "Your report status changed to MATCHED",
          actor_id: null,
          actor_username: null,
        }),
      ],
      error: null,
    });

    const items = await fetchNotifications();

    expect(items).toEqual([
      expect.objectContaining({
        id: "n9",
        type: "STATUS",
        preview: "Your report status changed to MATCHED",
        actorId: null,
        actorUsername: null,
      }),
    ]);
  });

  it("reads the soft-deleted view when asked", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    await fetchNotifications({ deleted: true });
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_list_notifications_client", {
      p_deleted: true,
    });
  });

  it("maps an auth failure to 401", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Not authenticated", code: "28000" },
    });
    await expect(fetchNotifications()).rejects.toMatchObject({ status: 401 });
  });
});

describe("fetchUnreadCount", () => {
  it("returns the unread count", async () => {
    clientMock.rpc.mockResolvedValue({ data: 3, error: null });
    expect(await fetchUnreadCount()).toBe(3);
  });

  it("treats null as zero", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchUnreadCount()).toBe(0);
  });
});

describe("markNotificationsRead", () => {
  it("marks the given ids read and returns the updated count", async () => {
    clientMock.rpc.mockResolvedValue({ data: 2, error: null });

    const updated = await markNotificationsRead(["n1", "n2"]);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_mark_notifications_read_client", {
      p_ids: ["n1", "n2"],
    });
    expect(updated).toBe(2);
  });

  it("marks everything read when no ids are given", async () => {
    clientMock.rpc.mockResolvedValue({ data: 5, error: null });

    const updated = await markNotificationsRead();

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_mark_notifications_read_client", {
      p_ids: null,
    });
    expect(updated).toBe(5);
  });
});

describe("markNotificationsUnread", () => {
  it("marks the given ids unread", async () => {
    clientMock.rpc.mockResolvedValue({ data: 1, error: null });

    expect(await markNotificationsUnread(["n1"])).toBe(1);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_mark_notifications_unread_client", {
      p_ids: ["n1"],
    });
  });

  it("marks the whole active inbox unread when no ids are given", async () => {
    clientMock.rpc.mockResolvedValue({ data: 4, error: null });
    await markNotificationsUnread();
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_mark_notifications_unread_client", {
      p_ids: null,
    });
  });
});

describe("deleteNotifications / restoreNotifications", () => {
  it("soft-deletes the given ids and returns the updated count", async () => {
    clientMock.rpc.mockResolvedValue({ data: 2, error: null });

    expect(await deleteNotifications(["n1", "n2"])).toBe(2);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_delete_notifications_client", {
      p_ids: ["n1", "n2"],
    });
  });

  it("soft-deletes everything when no ids are given", async () => {
    clientMock.rpc.mockResolvedValue({ data: 3, error: null });
    await deleteNotifications();
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_delete_notifications_client", {
      p_ids: null,
    });
  });

  it("restores the given ids", async () => {
    clientMock.rpc.mockResolvedValue({ data: 1, error: null });
    expect(await restoreNotifications(["n9"])).toBe(1);
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_restore_notifications_client", {
      p_ids: ["n9"],
    });
  });

  it("maps an ownership failure to 403", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "denied", code: "42501" },
    });
    await expect(deleteNotifications(["n1"])).rejects.toMatchObject({ status: 403 });
  });
});

describe("fetchNotifications REACTION kind (W1-A FBX-009)", () => {
  it("maps a REACTION row with its canonical reaction_kind", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [row({ id: "n7", type: "REACTION", reaction_kind: "WOW" })],
      error: null,
    });

    const items = await fetchNotifications();

    expect(items).toEqual([
      expect.objectContaining({ id: "n7", type: "REACTION", reactionKind: "WOW" }),
    ]);
  });

  it("maps a legacy LIKE row with a null reactionKind", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row({ type: "LIKE" })], error: null });

    const items = await fetchNotifications();

    expect(items[0]).toEqual(expect.objectContaining({ type: "LIKE", reactionKind: null }));
  });

  it("maps an unknown future DB type to client-only UNKNOWN (fail-safe)", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row({ type: "SUPER_LIKE" })], error: null });

    const items = await fetchNotifications();

    expect(items).toEqual([
      expect.objectContaining({ id: "n1", type: "UNKNOWN", reactionKind: null }),
    ]);
  });
});

describe("fetchNotifications blocked_actor (O5 / CF-060 B1)", () => {
  it("carries the caller's blocked_actor bit from the wire", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [row({ id: "n1", blocked_actor: true }), row({ id: "n2", blocked_actor: false })],
      error: null,
    });

    const items = await fetchNotifications();

    expect(items[0]).toEqual(expect.objectContaining({ id: "n1", blockedActor: true }));
    expect(items[1]).toEqual(expect.objectContaining({ id: "n2", blockedActor: false }));
  });

  it("leaves the bit absent when the backend does not project it, and never reads a non-boolean as true", async () => {
    // The canonical absent-preserving bit (the same one `services/posts.ts`
    // carries): "the backend does not project this bit" stays
    // distinguishable from "the bit is false". The rendering is identical
    // for absent and for false.
    clientMock.rpc.mockResolvedValue({
      data: [row({ id: "n1" }), row({ id: "n2", blocked_actor: "true" })],
      error: null,
    });

    const items = await fetchNotifications();

    expect(items[0]!.blockedActor).toBeUndefined();
    expect("blockedActor" in items[0]!).toBe(false);
    expect(items[1]!.blockedActor).toBeUndefined();
    expect("blockedActor" in items[1]!).toBe(false);
  });
});
