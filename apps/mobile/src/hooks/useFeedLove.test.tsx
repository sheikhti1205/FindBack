// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedLoveProvider, useFeedLove } from "./useFeedLove";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
}));

vi.mock("../services/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

function item(overrides: Partial<PostItem> = {}): PostItem {
  const now = new Date().toISOString();
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Lost keys",
    description: "keys",
    category: "Personal",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: null,
    youtubeUrl: null,
    createdAt: now,
    updatedAt: now,
    likeCount: 4,
    dislikeCount: 1,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
    ...overrides,
  } as PostItem;
}

function Probe({ postId }: { postId: string }) {
  const love = useFeedLove(postId);
  if (!love) throw new Error("useFeedLove must be used inside FeedLoveProvider");
  return (
    <div>
      <span data-testid={`reaction-${postId}`}>{love.myReaction ?? "none"}</span>
      <span data-testid={`likes-${postId}`}>{love.likeCount}</span>
      <span data-testid={`pending-${postId}`}>{love.pending ? "yes" : "no"}</span>
      <button type="button" data-testid={`toggle-${postId}`} onClick={() => void love.toggle()}>
        toggle {postId}
      </button>
    </div>
  );
}

function renderLoved(items: PostItem[], patchItem: (id: string, patch: Partial<PostItem>) => void) {
  return render(
    <FeedLoveProvider items={items} patchItem={patchItem}>
      {items.map((p) => (
        <Probe key={p.id} postId={p.id} />
      ))}
    </FeedLoveProvider>,
  );
}

beforeEach(() => {
  clientMock.rpc.mockReset();
});

afterEach(cleanup);

describe("FeedLoveProvider batch hydration", () => {
  it("hydrates N cards with a single batch RPC call", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        { post_id: "p1", my_reaction: "LIKE", my_rating: null },
        { post_id: "p2", my_reaction: null, my_rating: null },
        { post_id: "p3", my_reaction: "DISLIKE", my_rating: null },
      ],
      error: null,
    });
    const patchItem = vi.fn();

    renderLoved([item({ id: "p1" }), item({ id: "p2" }), item({ id: "p3" })], patchItem);

    await waitFor(() => expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE"));
    expect(screen.getByTestId("reaction-p2").textContent).toBe("none");
    expect(screen.getByTestId("reaction-p3").textContent).toBe("DISLIKE");
    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_feed_reaction_state_client", {
      p_post_ids: ["p1", "p2", "p3"],
    });
  });

  it("never hydrates per card via fetchSocialState", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    renderLoved([item({ id: "p1" }), item({ id: "p2" })], vi.fn());
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));

    const names = clientMock.rpc.mock.calls.map((c) => c[0] as string);
    expect(names).not.toContain("findback_post_social_state_client");
    expect(names).not.toContain("fetchSocialState");
  });

  it("chunks ids larger than the 20-id RPC limit", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    const items = Array.from({ length: 25 }, (_, i) => item({ id: `p${i}` }));
    const patchItem = vi.fn();

    render(
      <FeedLoveProvider items={items} patchItem={patchItem}>
        <Probe postId="p0" />
      </FeedLoveProvider>,
    );

    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(2));
    expect(clientMock.rpc).toHaveBeenNthCalledWith(1, "findback_feed_reaction_state_client", {
      p_post_ids: items.slice(0, 20).map((p) => p.id),
    });
    expect(clientMock.rpc).toHaveBeenNthCalledWith(2, "findback_feed_reaction_state_client", {
      p_post_ids: items.slice(20).map((p) => p.id),
    });
  });

  it("makes no hydration call for an empty feed", async () => {
    render(
      <FeedLoveProvider items={[]} patchItem={vi.fn()}>
        <span>empty</span>
      </FeedLoveProvider>,
    );

    expect(screen.getByText("empty")).toBeTruthy();
    await act(async () => {});
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("stays unhydrated (never crashes) when hydration fails", async () => {
    clientMock.rpc.mockRejectedValue(new Error("offline"));
    const patchItem = vi.fn();

    renderLoved([item({ id: "p1" })], patchItem);

    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("reaction-p1").textContent).toBe("none");
    expect(screen.getByText("toggle p1")).toBeTruthy();
  });
});

describe("FeedLoveProvider optimistic Love toggle", () => {
  it("loves optimistically and patches the feed cache item", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", like_count: 5, dislike_count: 1, my_reaction: "LIKE" }],
      error: null,
    });
    const patchItem = vi.fn();
    renderLoved([item({ id: "p1", likeCount: 4, dislikeCount: 1 })], patchItem);
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));
    patchItem.mockClear();

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    // Optimistic state flips immediately; patchItem carries the +1 like.
    expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE");
    expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 5, dislikeCount: 1 });
    // The toggle goes through the existing react RPC (LIKE, never LOVE).
    expect(clientMock.rpc).toHaveBeenLastCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LIKE",
    });
    await waitFor(() => expect(screen.getByTestId("pending-p1").textContent).toBe("no"));
  });

  it("unloves from LIKE via null and decrements the cached like count", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", my_reaction: "LIKE", my_rating: null }],
      error: null,
    });
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", like_count: 3, dislike_count: 1, my_reaction: null }],
      error: null,
    });
    const patchItem = vi.fn();
    renderLoved([item({ id: "p1", likeCount: 4, dislikeCount: 1 })], patchItem);
    await waitFor(() => expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE"));
    patchItem.mockClear();

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    expect(screen.getByTestId("reaction-p1").textContent).toBe("none");
    expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 3, dislikeCount: 1 });
    expect(clientMock.rpc).toHaveBeenLastCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: null,
    });
  });

  it("switches DISLIKE to LIKE, moving one vote across", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", my_reaction: "DISLIKE", my_rating: null }],
      error: null,
    });
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", like_count: 5, dislike_count: 0, my_reaction: "LIKE" }],
      error: null,
    });
    const patchItem = vi.fn();
    renderLoved([item({ id: "p1", likeCount: 4, dislikeCount: 1 })], patchItem);
    await waitFor(() => expect(screen.getByTestId("reaction-p1").textContent).toBe("DISLIKE"));
    patchItem.mockClear();

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE");
    expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 5, dislikeCount: 0 });
    expect(clientMock.rpc).toHaveBeenLastCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LIKE",
    });
  });

  it("rolls the optimistic update back when the toggle fails", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockRejectedValueOnce(new Error("offline"));
    const patchItem = vi.fn();
    renderLoved([item({ id: "p1", likeCount: 4, dislikeCount: 1 })], patchItem);
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));
    patchItem.mockClear();

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    await waitFor(() => expect(screen.getByTestId("pending-p1").textContent).toBe("no"));
    expect(screen.getByTestId("reaction-p1").textContent).toBe("none");
    // Rollback restores the exact pre-toggle counts in the feed cache.
    expect(patchItem).toHaveBeenLastCalledWith("p1", { likeCount: 4, dislikeCount: 1 });
  });
});
