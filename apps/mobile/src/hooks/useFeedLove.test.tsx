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

  it("reports toggle failure (false) so the caller can announce instead of silently reverting", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockRejectedValueOnce(new Error("offline"));
    const patchItem = vi.fn();
    let result: boolean | null = null;
    function ResultProbe() {
      const love = useFeedLove("p1");
      if (!love) throw new Error("useFeedLove must be used inside FeedLoveProvider");
      return (
        <button
          type="button"
          data-testid="toggle-result"
          onClick={() => {
            void love.toggle().then((ok) => {
              result = ok;
            });
          }}
        >
          resolve toggle
        </button>
      );
    }
    render(
      <FeedLoveProvider items={[item({ id: "p1" })]} patchItem={patchItem}>
        <ResultProbe />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByTestId("toggle-result").click();
    });

    await waitFor(() => expect(result).toBe(false));
  });

  it("reports an in-flight second toggle as handled (true), never a failure", async () => {    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    let release!: (value: { data: unknown[]; error: null }) => void;
    clientMock.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const patchItem = vi.fn();
    const results: boolean[] = [];
    function InFlightProbe() {
      const love = useFeedLove("p1");
      if (!love) throw new Error("useFeedLove must be used inside FeedLoveProvider");
      return (
        <button
          type="button"
          data-testid="toggle-inflight"
          onClick={() => {
            void love.toggle().then((ok) => {
              results.push(ok);
            });
          }}
        >
          toggle twice
        </button>
      );
    }
    render(
      <FeedLoveProvider items={[item({ id: "p1" })]} patchItem={patchItem}>
        <InFlightProbe />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));

    // The second tap lands while the first request is still in flight.
    act(() => {
      screen.getByTestId("toggle-inflight").click();
      screen.getByTestId("toggle-inflight").click();
    });

    release({
      data: [{ post_id: "p1", like_count: 5, dislike_count: 1, my_reaction: "LIKE" }],
      error: null,
    });
    await waitFor(() => expect(results).toHaveLength(2));
    // In-flight is not failure: the first request owns the outcome.
    expect(results).toEqual([true, true]);
    // No duplicate request: hydration + exactly one toggle.
    expect(clientMock.rpc).toHaveBeenCalledTimes(2);
  });
});

function LikeProbe({ postId }: { postId: string }) {
  const love = useFeedLove(postId);
  if (!love) throw new Error("useFeedLove must be used inside FeedLoveProvider");
  return (
    <div>
      <span data-testid={`reaction-${postId}`}>{love.myReaction ?? "none"}</span>
      <span data-testid={`mine-${postId}`}>{love.mine ? "yes" : "no"}</span>
      <span data-testid={`likes-${postId}`}>{love.likeCount}</span>
      <button type="button" data-testid={`toggle-${postId}`} onClick={() => void love.toggle()}>
        toggle {postId}
      </button>
    </div>
  );
}

describe("FeedLoveProvider Like-only reactions (packet 08 §2)", () => {
  it("counts the server's positive kinds and reports the caller's own Like", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockResolvedValueOnce({
      data: [
        {
          post_id: "p1",
          like_count: 5,
          dislike_count: 1,
          my_reaction: "LIKE",
          reaction_counts: { LOVE: 5, DISLIKE: 1 },
        },
      ],
      error: null,
    });
    render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4, dislikeCount: 1 })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    expect(clientMock.rpc).toHaveBeenLastCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LIKE",
    });
    // Server truth: five positive reactions (DISLIKE never counts), mine.
    await waitFor(() => expect(screen.getByTestId("likes-p1").textContent).toBe("5"));
    expect(screen.getByTestId("mine-p1").textContent).toBe("yes");
    expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE");
  });

  it("treats a canonical-era Helpful row as mine and clears it on the next tap", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", my_reaction: "HELPFUL", my_rating: null }],
      error: null,
    });
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", like_count: 4, dislike_count: 0, my_reaction: null, reaction_counts: { LOVE: 4 } }],
      error: null,
    });
    render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4, dislikeCount: 0 })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("mine-p1").textContent).toBe("yes"));

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    expect(clientMock.rpc).toHaveBeenLastCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: null,
    });
    await waitFor(() => expect(screen.getByTestId("mine-p1").textContent).toBe("no"));
    expect(screen.getByTestId("reaction-p1").textContent).toBe("none");
  });

  it("reads the batch-hydrated reaction without refetching per card", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", my_reaction: "WOW", my_rating: null }],
      error: null,
    });
    render(
      <FeedLoveProvider items={[item({ id: "p1" })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("reaction-p1").textContent).toBe("WOW"));
    expect(screen.getByTestId("mine-p1").textContent).toBe("yes");
    // One batch call only — no per-card hydration.
    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
  });

  it("shows the legacy like column before any summary is known", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 7, dislikeCount: 2 })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );

    expect(screen.getByTestId("likes-p1").textContent).toBe("7");
    expect(screen.getByTestId("mine-p1").textContent).toBe("no");
  });

  it("rolls the optimistic Like back and reports false when the RPC fails", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockRejectedValueOnce(new Error("offline"));
    const patchItem = vi.fn();
    let result: boolean | null = null;
    function ResultProbe() {
      const love = useFeedLove("p1");
      if (!love) throw new Error("useFeedLove must be used inside FeedLoveProvider");
      return (
        <button
          type="button"
          data-testid="like-result"
          onClick={() => {
            void love.toggle().then((ok) => {
              result = ok;
            });
          }}
        >
          like
        </button>
      );
    }
    render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4 })]} patchItem={patchItem}>
        <ResultProbe />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));
    patchItem.mockClear();

    await act(async () => {
      screen.getByTestId("like-result").click();
    });

    await waitFor(() => expect(result).toBe(false));
    // The failed tap leaves no optimism behind.
    expect(patchItem).toHaveBeenLastCalledWith("p1", { likeCount: 4, dislikeCount: 1 });
  });
});

/**
 * Regressions for the two I1 MAJORs in REVIEW-CF030-CODE.md. Both were visible
 * to a consumer as a wrong number or a lying heart, and neither had a test:
 * - M1: the optimistic Like was seeded from the legacy bucket even when the card
 *   was displaying a canonical per-kind summary (7 → 5 → 8 instead of 7 → 8).
 * - M2: the caller's own hydrated row lost to a summary snapshot taken before it
 *   moved, and a later page's hydration replaced the write's server summary.
 */
describe("FeedLoveProvider summary reconciliation (REVIEW-CF030-CODE I1 M1/M2)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("M1: seeds the optimistic Like from the displayed canonical summary, never the legacy bucket", async () => {
    const react = deferred<{ data: unknown; error: null }>();
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockImplementationOnce(() => react.promise);
    render(
      <FeedLoveProvider
        items={[
          item({
            id: "p1",
            likeCount: 4,
            dislikeCount: 0,
            reactionSummary: { counts: { LOVE: 4, HELPFUL: 3 }, myReaction: null, total: 7 },
          }),
        ]}
        patchItem={vi.fn()}
      >
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("likes-p1").textContent).toBe("7"));

    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });

    // The card showed 7 canonical reactions; one more Like is 8. Seeding from
    // the legacy column would drop everyone else's Helpful for a round trip.
    expect(screen.getByTestId("likes-p1").textContent).toBe("8");
    expect(screen.getByTestId("mine-p1").textContent).toBe("yes");

    await act(async () => {
      react.resolve({
        data: [
          {
            post_id: "p1",
            like_count: 5,
            dislike_count: 0,
            my_reaction: "LIKE",
            reaction_counts: { LOVE: 5, HELPFUL: 3 },
          },
        ],
        error: null,
      });
    });
    await waitFor(() => expect(screen.getByTestId("likes-p1").textContent).toBe("8"));
  });

  it("M2: the caller's hydrated row wins over a stale summary and moves the count with it", async () => {
    clientMock.rpc.mockResolvedValueOnce({
      data: [{ post_id: "p1", my_reaction: "LIKE", my_rating: null }],
      error: null,
    });
    render(
      <FeedLoveProvider
        items={[
          item({
            id: "p1",
            likeCount: 5,
            dislikeCount: 0,
            // Snapshot taken before the caller liked: it excludes their row.
            reactionSummary: { counts: { LOVE: 4 }, myReaction: null, total: 4 },
          }),
        ]}
        patchItem={vi.fn()}
      >
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("mine-p1").textContent).toBe("yes"));
    expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE");
    // Count and heart agree: 4 + the caller's own row.
    expect(screen.getByTestId("likes-p1").textContent).toBe("5");
  });

  it("M2: a later page's hydration keeps the summary the Like already confirmed", async () => {
    clientMock.rpc.mockResolvedValueOnce({ data: [], error: null });
    clientMock.rpc.mockResolvedValueOnce({
      data: [
        { post_id: "p1", like_count: 5, dislike_count: 0, my_reaction: "LIKE", reaction_counts: { LOVE: 5 } },
      ],
      error: null,
    });
    clientMock.rpc.mockResolvedValueOnce({
      data: [
        { post_id: "p1", my_reaction: "LIKE", my_rating: null },
        { post_id: "p2", my_reaction: null, my_rating: null },
      ],
      error: null,
    });
    const view = render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4 })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(1));
    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });
    await waitFor(() => expect(screen.getByTestId("likes-p1").textContent).toBe("5"));

    // Scrolling loads one more card: the batch re-hydration carries no counts,
    // and the item prop still holds the pre-Like legacy column (patchItem is
    // not applied here), so only a kept summary can show 5.
    view.rerender(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4 }), item({ id: "p2" })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await waitFor(() => expect(clientMock.rpc).toHaveBeenCalledTimes(3));

    await waitFor(() => expect(screen.getByTestId("mine-p1").textContent).toBe("yes"));
    expect(screen.getByTestId("likes-p1").textContent).toBe("5");
  });

  it("M2: a hydration that started before the Like cannot un-fill the heart", async () => {
    const hydration = deferred<{ data: unknown; error: null }>();
    clientMock.rpc.mockImplementationOnce(() => hydration.promise);
    clientMock.rpc.mockResolvedValueOnce({
      data: [
        { post_id: "p1", like_count: 5, dislike_count: 0, my_reaction: "LIKE", reaction_counts: { LOVE: 5 } },
      ],
      error: null,
    });
    render(
      <FeedLoveProvider items={[item({ id: "p1", likeCount: 4 })]} patchItem={vi.fn()}>
        <LikeProbe postId="p1" />
      </FeedLoveProvider>,
    );
    await act(async () => {
      screen.getByTestId("toggle-p1").click();
    });
    await waitFor(() => expect(screen.getByTestId("mine-p1").textContent).toBe("yes"));

    // The older read predates the Like and says the caller has no row.
    await act(async () => {
      hydration.resolve({ data: [{ post_id: "p1", my_reaction: null, my_rating: null }], error: null });
    });

    expect(screen.getByTestId("mine-p1").textContent).toBe("yes");
    expect(screen.getByTestId("reaction-p1").textContent).toBe("LIKE");
    expect(screen.getByTestId("likes-p1").textContent).toBe("5");
  });
});
