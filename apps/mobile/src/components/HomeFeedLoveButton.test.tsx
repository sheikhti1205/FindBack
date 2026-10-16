// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import { FeedLoveProvider, type FeedPatchItem } from "../hooks/useFeedLove";

const { feedFetchMock, likeToggleMock, rpcMock } = vi.hoisted(() => ({
  feedFetchMock: vi.fn(),
  likeToggleMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("../services/feedReactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/feedReactions")>();
  return { ...actual, fetchFeedReactionState: feedFetchMock, toggleLikeReaction: likeToggleMock };
});

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ rpc: rpcMock }),
}));

function post(): PostItem {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice", emailVerified: false, phoneVerified: false, avatarUrl: null, createdAt: twoHoursAgo },
    type: "LOST",
    status: "OPEN",
    title: "Lost dog",
    description: "Near the park.",
    category: "Pet Accessories",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: null,
    youtubeUrl: null,
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    likeCount: 24,
    dislikeCount: 1,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
  } as PostItem;
}

function renderButton(
  target: PostItem = post(),
  reactions: Record<string, { myReaction: "LIKE" | "DISLIKE" | "HELPFUL" | null; myRating: number | null }> = {},
) {
  feedFetchMock.mockResolvedValue(reactions);
  return render(
    <MemoryRouter>
      <FeedLoveProvider items={[target]} patchItem={vi.fn() as unknown as FeedPatchItem}>
        <HomeFeedLoveButton postId={target.id} likeCount={target.likeCount} />
      </FeedLoveProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  feedFetchMock.mockReset();
  likeToggleMock.mockReset();
  rpcMock.mockReset();
  feedFetchMock.mockResolvedValue({});
  likeToggleMock.mockResolvedValue({
    postId: "p1",
    likeCount: 25,
    dislikeCount: 1,
    myReaction: "LIKE",
    reactionCounts: {
      counts: { LOVE: 25, DISLIKE: 1 },
      myReaction: "LIKE",
      total: 26,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HomeFeedLoveButton (packet 08 §2 — Like-only)", () => {
  it("keeps the like testid, flat styling and 44px target, and offers no picker", () => {
    renderButton();
    const like = screen.getByTestId("home-feed-love");
    expect(like.tagName).toBe("BUTTON");
    expect(like.getAttribute("type")).toBe("button");
    expect(like.className).toMatch(/fb-report-action/);
    expect(like.className).toMatch(/min-h-\[44px\]/);
    expect(like.className).toMatch(/min-w-\[44px\]/);
    // The tray, its chevron and every hold gesture are gone.
    expect(screen.queryByTestId("home-feed-choose-reaction")).toBeNull();
    expect(screen.queryByTestId("reaction-tray")).toBeNull();
    expect(like.getAttribute("aria-haspopup")).toBeNull();
  });

  it("likes with LIKE and unlikes with null on a second tap", async () => {
    renderButton();
    const like = screen.getByTestId("home-feed-love");
    expect(like.getAttribute("aria-pressed")).toBe("false");
    expect(like.getAttribute("aria-label")).toBe("Like this report, 24 likes");

    fireEvent.click(like);

    await waitFor(() => expect(likeToggleMock).toHaveBeenCalledWith("p1", null));
    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("true"));
    expect(like.getAttribute("aria-label")).toBe("Liked, 25 likes");

    // The second tap sees the written LIKE and clears the caller's row.
    fireEvent.click(like);
    await waitFor(() => expect(likeToggleMock).toHaveBeenLastCalledWith("p1", "LIKE"));
  });

  it("counts positive kinds only — a DISLIKE never fills the control", async () => {
    likeToggleMock.mockResolvedValue({
      postId: "p1",
      likeCount: 20,
      dislikeCount: 4,
      myReaction: "LIKE",
      reactionCounts: {
        counts: { LOVE: 20, WOW: 3, DISLIKE: 4 },
        myReaction: "LIKE",
        total: 27,
      },
    });
    renderButton();
    const like = screen.getByTestId("home-feed-love");

    fireEvent.click(like);

    await waitFor(() => expect(like.getAttribute("aria-label")).toBe("Liked, 23 likes"));
  });

  it("treats a hydrated canonical-era kind as mine and clears it on the next tap", async () => {
    renderButton(post(), { p1: { myReaction: "HELPFUL", myRating: null } });
    const like = screen.getByTestId("home-feed-love");

    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("true"));
    expect(like.getAttribute("aria-label")).toBe("Liked, 24 likes");

    fireEvent.click(like);

    await waitFor(() => expect(likeToggleMock).toHaveBeenCalledWith("p1", "HELPFUL"));
  });

  it("does not double-fire while a Like is in flight", async () => {
    let release!: (value: unknown) => void;
    likeToggleMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderButton();
    const like = screen.getByTestId("home-feed-love");

    fireEvent.click(like);
    await waitFor(() => expect(like.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(like);

    expect(likeToggleMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ postId: "p1", likeCount: 25, dislikeCount: 1, myReaction: "LIKE" });
    });
    await waitFor(() => expect(like.getAttribute("aria-busy")).toBe("false"));
  });

  it("announces a failed Like inline and reverts the control", async () => {
    const heard: string[] = [];
    const handler = (e: Event) => {
      heard.push((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("findback:announce", handler);
    try {
      likeToggleMock.mockRejectedValueOnce(new Error("offline"));
      renderButton();
      const like = screen.getByTestId("home-feed-love");

      fireEvent.click(like);

      expect((await screen.findByTestId("home-feed-love-error")).textContent).toMatch(/try again/i);
      await waitFor(() => expect(heard.join(" ")).toMatch(/try again/i));
      expect(like.getAttribute("aria-pressed")).toBe("false");
      expect(like.getAttribute("aria-label")).toBe("Like this report, 24 likes");
      expect(like.getAttribute("aria-describedby")).toBe("home-feed-like-error-p1");
    } finally {
      window.removeEventListener("findback:announce", handler);
    }
  });

  it("falls back to its own state outside a provider", async () => {
    render(<HomeFeedLoveButton postId="p1" likeCount={3} />);
    const like = screen.getByTestId("home-feed-love");
    expect(like.getAttribute("aria-label")).toBe("Like this report, 3 likes");

    fireEvent.click(like);

    await waitFor(() => expect(likeToggleMock).toHaveBeenCalledWith("p1", null));
    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("true"));
  });

  it("reverts the local fallback when the Like fails", async () => {
    likeToggleMock.mockRejectedValueOnce(new Error("offline"));
    render(<HomeFeedLoveButton postId="p1" likeCount={3} />);
    const like = screen.getByTestId("home-feed-love");

    fireEvent.click(like);

    await waitFor(() => expect(screen.getByTestId("home-feed-love-error")).toBeTruthy());
    expect(like.getAttribute("aria-pressed")).toBe("false");
  });
});
