// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  getPlatform: () => "web",
  Plugins: {},
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: vi.fn() },
}));

const { postsMock, findMock, authState, realtimeHandlers, rpcMock } = vi.hoisted(() => ({
  postsMock: {
    fetchPost: vi.fn(),
    fetchComments: vi.fn(),
    fetchSocialState: vi.fn(),
    addComment: vi.fn(),
    deleteComment: vi.fn(),
    reactToPost: vi.fn(),
    updatePostStatus: vi.fn(),
  },
  findMock: vi.fn(),
  authState: { user: { id: "u9", username: "reader" } as { id: string; username: string } | null },
  realtimeHandlers: new Map<string, (payload: unknown) => void>(),
  rpcMock: vi.fn(),
}));

vi.mock("../services/posts", () => postsMock);
vi.mock("../services/realtime", () => ({
  joinPostRoom: vi.fn(),
  leavePostRoom: vi.fn(),
  onRealtime: vi.fn((event: string, handler: (payload: unknown) => void) => {
    realtimeHandlers.set(event, handler);
    return () => {
      realtimeHandlers.delete(event);
    };
  }),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock }));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ rpc: rpcMock }),
}));

import { PostDetail } from "./PostDetail";
import { LiveRegion } from "../components/LiveRegion";

const basePost = {
  id: "p1",
  userId: "u2",
  author: { id: "u2", username: "owner" },
  type: "FOUND",
  status: "OPEN",
  title: "Found keys",
  description: "plain description",
  category: "Electronics",
  eventDate: "2026-09-01",
  latitude: null,
  longitude: null,
  locationLabel: null,
  youtubeUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  likeCount: 4,
  dislikeCount: 1,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 2,
  attachments: [],
};

const summerizedComment = {
  id: "c1",
  postId: "p1",
  parentId: null,
  depth: 0,
  body: "hope you find it",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  author: { id: "u3", username: "commenter" },
  reactionSummary: { counts: { LOVE: 2, WOW: 1 }, myReaction: null, total: 3 },
};

const reactedComment = {
  id: "c2",
  postId: "p1",
  parentId: null,
  depth: 0,
  body: "glad to help",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  author: { id: "u4", username: "helper" },
  reactionSummary: { counts: { LOVE: 2, HELPFUL: 1 }, myReaction: "HELPFUL", total: 3 },
};

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/posts/p1"]}>
      <Routes>
        <Route path="/posts/:id" element={<PostDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.user = { id: "u9", username: "reader" };
  realtimeHandlers.clear();
  postsMock.fetchPost.mockResolvedValue(basePost);
  postsMock.fetchComments.mockResolvedValue([summerizedComment, reactedComment]);
  postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
  postsMock.reactToPost.mockResolvedValue({
    postId: "p1",
    likeCount: 5,
    dislikeCount: 1,
    myReaction: "LIKE",
  });
  findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  rpcMock.mockResolvedValue({
    data: [{ comment_id: "c1", my_reaction: "LIKE", reaction_counts: { LOVE: 3, WOW: 1 } }],
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("PostDetail post Like (packet 08 §2 — Like-only)", () => {
  it("taps Like over the real post RPC and unlikes on the second tap", async () => {
    renderDetail();
    const like = await screen.findByTestId("detail-like");
    expect(like.getAttribute("aria-label")).toBe("Like, 4 likes");
    expect(like.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(like);

    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE"));
    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("true"));
    // The optimistic count moves with the tap, before the server answers.
    expect(like.getAttribute("aria-label")).toBe("Liked, 5 likes");

    fireEvent.click(like);
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenLastCalledWith("p1", null));
  });

  it("offers no tray, no chevron and no hold gesture", async () => {
    renderDetail();
    const like = await screen.findByTestId("detail-like");
    expect(screen.queryByTestId("detail-choose-reaction")).toBeNull();
    expect(screen.queryByTestId("reaction-tray")).toBeNull();
    expect(like.getAttribute("aria-haspopup")).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(like, { clientX: 10, clientY: 10, button: 0 });
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(screen.queryByTestId("reaction-tray")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(postsMock.reactToPost).not.toHaveBeenCalled();
  });

  it("sends exactly one write when a second tap lands in flight", async () => {
    let release!: (value: unknown) => void;
    postsMock.reactToPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderDetail();
    const like = await screen.findByTestId("detail-like");

    fireEvent.click(like);
    await waitFor(() => expect(like.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(like);

    expect(postsMock.reactToPost).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ postId: "p1", likeCount: 5, dislikeCount: 1, myReaction: "LIKE" });
    });
    await waitFor(() => expect(like.getAttribute("aria-busy")).toBe("false"));
  });

  it("announces a failed Like inline and reverts the optimistic state", async () => {
    render(<LiveRegion />);
    renderDetail();
    const like = await screen.findByTestId("detail-like");
    postsMock.reactToPost.mockRejectedValueOnce(new Error("Reaction could not be saved"));

    fireEvent.click(like);

    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE"));
    expect(screen.getByRole("alert").textContent).toBe("Reaction could not be saved");
    await waitFor(() =>
      expect(screen.getByTestId("live-region-announcement").textContent).toBe(
        "Reaction could not be saved",
      ),
    );
    await waitFor(() => expect(like.getAttribute("aria-pressed")).toBe("false"));
    expect(like.getAttribute("aria-label")).toBe("Like, 4 likes");
  });

  it("counts only positive kinds from a reaction:changed broadcast", async () => {
    renderDetail();
    await screen.findByTestId("detail-like");
    const handler = realtimeHandlers.get("reaction:changed");
    expect(handler).toBeTruthy();

    act(() => {
      handler!({
        postId: "p1",
        likeCount: 9,
        dislikeCount: 2,
        reactionCounts: { LOVE: 9, WOW: 2, DISLIKE: 2 },
      });
    });

    // 9 + 2 positive reactions; the two DISLIKEs never count.
    expect((await screen.findByTestId("detail-like")).getAttribute("aria-label")).toBe(
      "Like, 11 likes",
    );
  });
});

describe("PostDetail comment Like (packet 08 §2 — Like-only)", () => {
  it("labels each comment with its positive-reaction count and the caller's own state", async () => {
    renderDetail();
    expect(await screen.findByTestId("comment-react-c1")).toBeTruthy();
    expect(screen.getByTestId("comment-react-c1").getAttribute("aria-label")).toBe(
      "Like this comment, 3 likes",
    );
    expect(screen.getByTestId("comment-react-c1").getAttribute("aria-pressed")).toBe("false");
    // c2 carries a canonical-era Helpful row: mine, so the control is filled.
    expect(screen.getByTestId("comment-react-c2").getAttribute("aria-label")).toBe(
      "Liked, 3 likes",
    );
    expect(screen.getByTestId("comment-react-c2").getAttribute("aria-pressed")).toBe("true");
  });

  it("taps a comment Like through the real comment RPC", async () => {
    renderDetail();
    const control = await screen.findByTestId("comment-react-c1");

    fireEvent.click(control);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("findback_react_comment_client", {
        p_comment_id: "c1",
        p_type: "LIKE",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("comment-react-c1").getAttribute("aria-label")).toBe(
      "Liked, 4 likes",
    ));
  });

  it("clears a canonical-era Helpful row on the next tap instead of switching kinds", async () => {
    // c2 carries HELPFUL: under the Like rule the caller already holds a
    // positive reaction, so a tap removes the row (null) — never a new kind.
    renderDetail();
    rpcMock.mockResolvedValue({
      data: [{ comment_id: "c2", my_reaction: null, reaction_counts: { LOVE: 2 } }],
      error: null,
    });
    const control = await screen.findByTestId("comment-react-c2");

    fireEvent.click(control);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenLastCalledWith("findback_react_comment_client", {
        p_comment_id: "c2",
        p_type: null,
      }),
    );
    await waitFor(() => expect(control.getAttribute("aria-pressed")).toBe("false"));
    expect(control.getAttribute("aria-label")).toBe("Like this comment, 2 likes");
  });

  it("announces a failed comment Like inline with a full revert", async () => {
    render(<LiveRegion />);
    renderDetail();
    const control = await screen.findByTestId("comment-react-c1");
    rpcMock.mockRejectedValueOnce(new Error("Comment reaction failed"));

    fireEvent.click(control);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Comment reaction failed"));
    await waitFor(() =>
      expect(screen.getByTestId("live-region-announcement").textContent).toBe(
        "Comment reaction failed",
      ),
    );
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(control.getAttribute("aria-label")).toBe("Like this comment, 3 likes");
  });

  it("offers no comment tray or chevron either", async () => {
    renderDetail();
    await screen.findByTestId("comment-react-c1");
    expect(screen.queryByTestId("comment-choose-c1")).toBeNull();
    expect(screen.queryByTestId("reaction-tray")).toBeNull();
  });

  it("refetches a comment summary on invalidation without trusting shared counts", async () => {
    renderDetail();
    await screen.findByTestId("comment-react-c1");
    postsMock.fetchComments.mockResolvedValue([
      { ...summerizedComment, reactionSummary: { counts: { LOVE: 5, WOW: 4 }, myReaction: null, total: 9 } }, reactedComment,
    ]);
    const handler = realtimeHandlers.get("reaction:invalidate");
    expect(handler).toBeTruthy();

    act(() => {
      handler!({ postId: "p1", invalidate: true });
    });

    expect((await screen.findByTestId("comment-react-c1")).getAttribute("aria-label")).toBe(
      "Like this comment, 9 likes",
    );
    expect(postsMock.fetchComments).toHaveBeenCalledTimes(2);
    // The post control is untouched by a comment broadcast.
    expect(screen.getByTestId("detail-like").getAttribute("aria-label")).toBe("Like, 4 likes");
  });

  it("keeps the chosen reply target through another account's reaction invalidation", async () => {
    renderDetail();
    const replyControl = await screen.findByLabelText("Reply to commenter");
    fireEvent.click(replyControl);
    expect(screen.getByText(/Replying to/)).toBeTruthy();

    // A stranger likes a comment. The broadcast names no child and carries no
    // op: it must refresh through the authorized list, not destroy the draft.
    const handler = realtimeHandlers.get("reaction:invalidate");
    act(() => {
      handler!({ postId: "p1", invalidate: true });
    });

    await waitFor(() => expect(postsMock.fetchComments).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Replying to/)).toBeTruthy();
    // The list stays painted (no conceal) so the conversation does not blank.
    expect(screen.getByTestId("comment-react-c1")).toBeTruthy();
  });

  it("conceals only on a moderation signal and clears the reply target only when it is truly gone", async () => {
    renderDetail();
    fireEvent.click(await screen.findByLabelText("Reply to commenter"));
    expect(screen.getByText(/Replying to/)).toBeTruthy();

    const handler = realtimeHandlers.get("comment:invalidate");
    expect(handler).toBeTruthy();

    // Another account inserting a comment is a quiet refetch.
    act(() => {
      handler!({ postId: "p1", invalidate: true, op: "INSERT" });
    });
    await waitFor(() => expect(postsMock.fetchComments).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Replying to/)).toBeTruthy();

    // A moderation invalidation conceals the unverified bodies, and because the
    // refetched list still contains the parent the reply target survives.
    act(() => {
      handler!({ postId: "p1", invalidate: true, op: "MODERATION" });
    });
    await waitFor(() => expect(postsMock.fetchComments).toHaveBeenCalledTimes(3));
    expect(screen.getByText(/Replying to/)).toBeTruthy();

    // When the authorized list no longer contains it, it is genuinely gone.
    postsMock.fetchComments.mockResolvedValue([reactedComment]);
    act(() => {
      handler!({ postId: "p1", invalidate: true, op: "MODERATION" });
    });
    await waitFor(() => expect(screen.queryByText(/Replying to/)).toBeNull());
  });
});
