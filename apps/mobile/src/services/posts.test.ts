import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPost,
  fetchFeed,
  fetchMyPosts,
  fetchPost,
  updatePostStatus,
} from "./posts";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    user_id: "u1",
    type: "LOST",
    title: "Lost wallet",
    description: "black leather",
    category: "Personal",
    status: "OPEN",
    event_date: "2026-09-01",
    latitude: 23.8,
    longitude: 90.4,
    location_label: "Campus",
    youtube_url: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    author_username: "alice",
    author_email_verified: 1,
    author_phone_verified: 0,
    author_avatar_url: null,
    author_created_at: "2026-01-01T00:00:00.000Z",
    like_count: 2,
    dislike_count: 1,
    rating_avg: "4.50",
    rating_count: 2,
    comment_count: 3,
    attachments: [
      {
        id: "a1",
        post_id: "p1",
        file_url: "https://example.test/a.png",
        mime_type: "image/png",
        file_name: "a.png",
        file_size: 10,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    total_count: 12,
    ...overrides,
  };
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(() => {
  clientMock.rpc.mockReset();
  clientMock.auth.getUser.mockReset();
});

describe("fetchFeed", () => {
  it("queries the client-safe RPC with parsed filters and one extra row", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row()], error: null });

    const page = await fetchFeed({ type: "LOST", q: "wallet", sort: "oldest" });

    expect(clientMock.rpc).toHaveBeenCalledWith(
      "findback_query_posts_client",
      expect.objectContaining({
        p_type: "LOST",
        p_q: "wallet",
        p_order: "asc",
        p_limit: 11,
      }),
    );
    expect(page.total).toBe(12);
    expect(page.nextCursor).toBeNull();
  });

  it("maps a row into a PostItem with a public-only author", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row()], error: null });

    const post = (await fetchFeed({})).items[0]!;

    expect(post.author).toEqual({
      id: "u1",
      username: "alice",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect("email" in post.author).toBe(false);
    expect("phone" in post.author).toBe(false);
    expect(post.ratingAvg).toBe(4.5);
    expect(post.attachments[0]).toEqual({
      id: "a1",
      postId: "p1",
      fileUrl: "https://example.test/a.png",
      mimeType: "image/png",
      fileName: "a.png",
      fileSize: 10,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("returns a keyset cursor when more than a page exists", async () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      row({
        id: `p${String(i).padStart(2, "0")}`,
        created_at: `2026-09-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    clientMock.rpc.mockResolvedValue({ data: rows, error: null });

    const page = await fetchFeed({});

    expect(page.items).toHaveLength(10);
    const cursor = page.nextCursor!;
    expect(cursor).toBeTruthy();
    expect(cursor).not.toContain("=");
    expect(JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")))).toEqual([
      "2026-09-11T00:00:00.000Z",
      "p09",
    ]);
  });

  it("passes a decoded cursor back to the RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    const cursor = base64url(JSON.stringify(["2026-09-11T00:00:00.000Z", "p09"]));

    await fetchFeed({}, cursor);

    expect(clientMock.rpc).toHaveBeenCalledWith(
      "findback_query_posts_client",
      expect.objectContaining({
        p_cursor_created_at: "2026-09-11T00:00:00.000Z",
        p_cursor_id: "p09",
      }),
    );
  });

  it("reports an empty feed without a cursor", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchFeed({})).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});

describe("fetchPost", () => {
  it("looks a single post up by id", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row()], error: null });

    const post = await fetchPost("p1");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_query_posts_client", {
      p_post_id: "p1",
      p_limit: 1,
    });
    expect(post.id).toBe("p1");
  });

  it("throws 404 when no post matches", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    await expect(fetchPost("missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("fetchMyPosts", () => {
  it("filters by the session user id", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: { id: "u9" } }, error: null });
    clientMock.rpc.mockResolvedValue({ data: [row()], error: null });

    const page = await fetchMyPosts();

    expect(clientMock.rpc).toHaveBeenCalledWith(
      "findback_query_posts_client",
      expect.objectContaining({ p_user_id: "u9", p_order: "desc", p_limit: 11 }),
    );
    expect(page.total).toBe(1);
  });

  it("requires an authenticated session", async () => {
    clientMock.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(fetchMyPosts()).rejects.toThrow("Not authenticated");
  });
});

describe("createPost", () => {
  const input = {
    type: "LOST" as const,
    title: "Lost phone",
    description: "a black phone lost on campus",
    category: "Electronics" as const,
    eventDate: "2026-09-10",
  };

  it("calls the create RPC and returns the fresh public post", async () => {
    clientMock.rpc
      .mockResolvedValueOnce({ data: "new-id", error: null })
      .mockResolvedValueOnce({ data: [row({ id: "new-id" })], error: null });

    const post = await createPost(input);

    expect(clientMock.rpc).toHaveBeenNthCalledWith(
      1,
      "findback_create_post_client",
      expect.objectContaining({
        p_type: "LOST",
        p_title: "Lost phone",
        p_category: "Electronics",
        p_event_date: "2026-09-10",
        p_attachment_key: null,
      }),
    );
    expect(post.id).toBe("new-id");
  });

  it("maps an ownership rejection to 403", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Attachment was not uploaded by you", code: "42501" },
    });
    await expect(createPost(input)).rejects.toMatchObject({ status: 403 });
  });
});

describe("updatePostStatus", () => {
  it("changes status then refetches the post", async () => {
    clientMock.rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [row({ status: "RECOVERED" })], error: null });

    const post = await updatePostStatus("p1", "RECOVERED");

    expect(clientMock.rpc).toHaveBeenNthCalledWith(
      1,
      "findback_change_post_status_client",
      { p_post_id: "p1", p_status: "RECOVERED" },
    );
    expect(post.status).toBe("RECOVERED");
  });
});
