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
    ratePost: vi.fn(),
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
    data: [{ comment_id: "c1", my_reaction: "LOVE", reaction_counts: { LOVE: 3, WOW: 1 } }],
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("PostDetail post reactions (W3.3)", () => {
  it("taps the default Love over the real post RPC and unreacts on second tap", async () => {
    renderDetail();
    const love = await screen.findByRole("button", { name: /love, 4 loves/i });
    expect(love.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(love);
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE"));
    await waitFor(() => expect(love.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(love);
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenLastCalledWith("p1", null));
  });

  it("opens the tray on hold and writes the tapped kind (never faked over LIKE)", async () => {
    postsMock.reactToPost.mockResolvedValue({
      postId: "p1",
      likeCount: 4,
      dislikeCount: 1,
      myReaction: "HELPFUL",
      reactionCounts: { counts: { LOVE: 4, HELPFUL: 1 }, myReaction: "HELPFUL", total: 5 },
    });
    renderDetail();
    const love = await screen.findByRole("button", { name: /love, 4 loves/i });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("reaction-tray")).toBeTruthy();
      // The hold's own click must not toggle the default reaction.
      fireEvent.pointerUp(love);
      fireEvent.click(love);
      expect(postsMock.reactToPost).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("reaction-option-HELPFUL"));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "HELPFUL"));
    expect(await screen.findByRole("button", { name: /helpful, 5 reactions/i })).toBeTruthy();
  });

  it("cancels the tray when the hold becomes a scroll or pointercancel", async () => {
    renderDetail();
    const love = await screen.findByRole("button", { name: /love, 4 loves/i });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerMove(love, { clientX: 10, clientY: 80 });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("reaction-tray")).toBeNull();
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerCancel(love);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("reaction-tray")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(postsMock.reactToPost).not.toHaveBeenCalled();
  });

  it("selects a kind through the Choose reaction keyboard path (no long-press)", async () => {
    postsMock.reactToPost.mockResolvedValue({
      postId: "p1",
      likeCount: 4,
      dislikeCount: 1,
      myReaction: "WOW",
      reactionCounts: { counts: { LOVE: 4, WOW: 1 }, myReaction: "WOW", total: 5 },
    });
    renderDetail();
    await screen.findByRole("button", { name: /love, 4 loves/i });
    fireEvent.click(screen.getByTestId("detail-choose-reaction"));
    const tray = await screen.findByTestId("reaction-tray");
    expect(screen.getByTestId("detail-choose-reaction").getAttribute("aria-expanded")).toBe("true");
    screen.getByTestId("reaction-option-LOVE").focus();
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("reaction-option-WOW");
    fireEvent.keyDown(tray, { key: "Enter" });
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "WOW"));
    expect(await screen.findByRole("button", { name: /wow, 5 reactions/i })).toBeTruthy();
  });

  it("announces a failed tray write inline and reverts the optimistic reaction", async () => {
    render(<LiveRegion />);
    renderDetail();
    await screen.findByRole("button", { name: /love, 4 loves/i });
    postsMock.reactToPost.mockRejectedValueOnce(new Error("Reaction could not be saved"));
    fireEvent.click(screen.getByTestId("detail-choose-reaction"));
    fireEvent.click(await screen.findByTestId("reaction-option-SUPPORT"));
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "SUPPORT"));
    expect(screen.getByRole("alert").textContent).toBe("Reaction could not be saved");
    await waitFor(() =>
      expect(screen.getByTestId("live-region-announcement").textContent).toBe(
        "Reaction could not be saved",
      ),
    );
    expect((await screen.findByRole("button", { name: /love, 4 loves/i })).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("patches post counts live from a reaction:changed broadcast", async () => {
    renderDetail();
    await screen.findByRole("button", { name: /love, 4 loves/i });
    const handler = realtimeHandlers.get("reaction:changed");
    expect(handler).toBeTruthy();
    act(() => {
      handler!({
        postId: "p1",
        likeCount: 9,
        dislikeCount: 2,
        reactionCounts: { LOVE: 9, WOW: 2 },
      });
    });
    expect(await screen.findByRole("button", { name: /love, 9 loves/i })).toBeTruthy();
  });
});

describe("PostDetail comment reactions (W3.3)", () => {
  it("shows each comment's top kind + total from the fetched summary", async () => {
    renderDetail();
    expect(await screen.findByTestId("comment-react-c1")).toBeTruthy();
    expect(screen.getByTestId("comment-react-c1").getAttribute("aria-label")).toMatch(
      /love, 3 reactions/i,
    );
    expect(screen.getByTestId("comment-react-c1").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("comment-react-c2").getAttribute("aria-label")).toMatch(
      /helpful, 3 reactions/i,
    );
    expect(screen.getByTestId("comment-react-c2").getAttribute("aria-pressed")).toBe("true");
  });

  it("taps the default Love on a comment through the real comment RPC", async () => {
    renderDetail();
    const control = await screen.findByTestId("comment-react-c1");
    fireEvent.click(control);
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("findback_react_comment_client", {
        p_comment_id: "c1",
        p_type: "LOVE",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("comment-react-c1").getAttribute("aria-label")).toMatch(
        /love, 4 reactions/i,
      ),
    );
  });

  it("switches to Love when tapping default with another kind active, unreacts on Love", async () => {
    // c2 carries HELPFUL: a default tap switches to LOVE (it is not the
    // active kind), and a second tap on the now-active LOVE clears it.
    rpcMock.mockResolvedValue({
      data: [{ comment_id: "c2", my_reaction: "LOVE", reaction_counts: { LOVE: 3 } }],
      error: null,
    });
    renderDetail();
    fireEvent.click(await screen.findByTestId("comment-react-c2"));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("findback_react_comment_client", {
        p_comment_id: "c2",
        p_type: "LOVE",
      }),
    );
    rpcMock.mockResolvedValue({
      data: [{ comment_id: "c2", my_reaction: null, reaction_counts: { LOVE: 2 } }],
      error: null,
    });
    fireEvent.click(screen.getByTestId("comment-react-c2"));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenLastCalledWith("findback_react_comment_client", {
        p_comment_id: "c2",
        p_type: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("comment-react-c2").getAttribute("aria-pressed")).toBe("false"),
    );
  });

  it("reacts from the comment tray and announces failures inline with revert", async () => {
    render(<LiveRegion />);
    renderDetail();
    fireEvent.click(await screen.findByTestId("comment-choose-c1"));
    fireEvent.click(await screen.findByTestId("reaction-option-SUPPORT"));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("findback_react_comment_client", {
        p_comment_id: "c1",
        p_type: "SUPPORT",
      }),
    );
    // Server truth for c1 stays LOVE in this mock (RPC mock resolves LOVE
    // above for the c1 default) — the optimistic SUPPORT is replaced by it.
    rpcMock.mockRejectedValueOnce(new Error("Comment reaction failed"));
    const control = screen.getByTestId("comment-react-c1");
    fireEvent.click(control);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Comment reaction failed"));
    await waitFor(() =>
      expect(screen.getByTestId("live-region-announcement").textContent).toBe(
        "Comment reaction failed",
      ),
    );
  });

  it("patches a comment summary live from a comment reaction:changed broadcast", async () => {
    renderDetail();
    await screen.findByTestId("comment-react-c1");
    const handler = realtimeHandlers.get("reaction:changed");
    expect(handler).toBeTruthy();
    act(() => {
      handler!({ postId: "p1", commentId: "c1", reactionCounts: { LOVE: 5, WOW: 4 } });
    });
    expect(screen.getByTestId("comment-react-c1").getAttribute("aria-label")).toMatch(
      /love, 9 reactions/i,
    );
    // The post control is untouched by a comment broadcast.
    expect(screen.getByRole("button", { name: /love, 4 loves/i })).toBeTruthy();
  });
});
