import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addComment,
  createPost,
  deleteComment,
  fetchComments,
  fetchFeed,
  fetchMyPosts,
  fetchPost,
  fetchSocialState,
  ratePost,
  reactToPost,
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

  it("passes a userId filter for My Reports pagination", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await fetchFeed({ userId: "u9" });

    expect(clientMock.rpc).toHaveBeenCalledWith(
      "findback_query_posts_client",
      expect.objectContaining({ p_user_id: "u9" }),
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

  it("calls the create RPC once and returns the new id without refetching", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: "new-id", error: null });

    const id = await createPost(input);

    expect(id).toBe("new-id");
    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
    expect(clientMock.rpc).toHaveBeenCalledWith(
      "findback_create_post_client",
      expect.objectContaining({ p_type: "LOST", p_attachment_key: null }),
    );
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

function commentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    post_id: "p1",
    body: "hope you find it",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    author_id: "u2",
    author_username: "bob",
    author_email_verified: 1,
    author_phone_verified: 0,
    author_avatar_url: null,
    author_created_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("fetchComments", () => {
  it("reads comments via the client RPC with a public-only author", async () => {
    clientMock.rpc.mockResolvedValue({ data: [commentRow()], error: null });

    const comments = await fetchComments("p1");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_list_comments_client", {
      p_post_id: "p1",
    });
    expect(comments[0]).toEqual({
      id: "c1",
      postId: "p1",
      author: {
        id: "u2",
        username: "bob",
        emailVerified: true,
        phoneVerified: false,
        avatarUrl: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      body: "hope you find it",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect("email" in comments[0]!.author).toBe(false);
    expect("phone" in comments[0]!.author).toBe(false);
  });
});

describe("addComment", () => {
  it("creates a comment and maps the returned row", async () => {
    clientMock.rpc.mockResolvedValue({ data: [commentRow({ id: "c9" })], error: null });

    const comment = await addComment("p1", "thanks!");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_add_comment_client", {
      p_post_id: "p1",
      p_body: "thanks!",
    });
    expect(comment.id).toBe("c9");
  });

  it("maps a missing post to 404", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Post not found", code: "P0002" },
    });
    await expect(addComment("missing", "hi")).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteComment", () => {
  it("deletes by comment id", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });

    await deleteComment("p1", "c1");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_delete_comment_client", {
      p_comment_id: "c1",
    });
  });

  it("maps a not-owner rejection to 403", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Comment not found or not allowed", code: "42501" },
    });
    await expect(deleteComment("p1", "c1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("reactToPost", () => {
  it("returns counts and the caller reaction", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ post_id: "p1", like_count: 3, dislike_count: 1, my_reaction: "LIKE" }],
      error: null,
    });

    const res = await reactToPost("p1", "LIKE");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LIKE",
    });
    expect(res).toEqual({ postId: "p1", likeCount: 3, dislikeCount: 1, myReaction: "LIKE" });
  });

  it("treats a null reaction as removal", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ post_id: "p1", like_count: 0, dislike_count: 0, my_reaction: null }],
      error: null,
    });

    const res = await reactToPost("p1", null);

    expect(res.myReaction).toBeNull();
    expect(res.likeCount).toBe(0);
  });
});

describe("ratePost", () => {
  it("returns the live average/count for the caller score", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ post_id: "p1", score: 5, rating_avg: "4.33", rating_count: 3 }],
      error: null,
    });

    const res = await ratePost("p1", 5);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_rate_client", {
      p_post_id: "p1",
      p_score: 5,
    });
    expect(res).toEqual({ postId: "p1", score: 5, ratingAvg: 4.33, ratingCount: 3 });
  });
});

describe("fetchSocialState", () => {
  it("hydrates the caller's own reaction and rating", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ my_reaction: "DISLIKE", my_rating: 2 }],
      error: null,
    });

    const state = await fetchSocialState("p1");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_post_social_state_client", {
      p_post_id: "p1",
    });
    expect(state).toEqual({ myReaction: "DISLIKE", myRating: 2 });
  });

  it("returns nulls when the caller has no reaction or rating", async () => {
    clientMock.rpc.mockResolvedValue({ data: [{ my_reaction: null, my_rating: null }], error: null });
    expect(await fetchSocialState("p1")).toEqual({ myReaction: null, myRating: null });
  });
});
