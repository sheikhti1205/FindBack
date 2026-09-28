import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
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

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_list_notifications_client", {});
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
