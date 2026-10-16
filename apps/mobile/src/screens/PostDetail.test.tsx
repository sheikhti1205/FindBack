// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "framer-motion";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: {},
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: vi.fn() },
}));

const { postsMock, findMock, authState } = vi.hoisted(() => ({
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
}));

vi.mock("../services/posts", () => postsMock);
vi.mock("../services/realtime", () => ({
  joinPostRoom: vi.fn(),
  leavePostRoom: vi.fn(),
  onRealtime: vi.fn(() => () => {}),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock }));

import { PostDetail } from "./PostDetail";
import { LiveRegion } from "../components/LiveRegion";

beforeEach(() => {
  authState.user = { id: "u9", username: "reader" };
});

const LONG = `a${"very".repeat(40)}longword`;

const basePost = {
  id: "p1",
  userId: "u2",
  author: { id: "u2", username: "owner" },
  type: "FOUND",
  status: "OPEN",
  title: LONG,
  description: "plain description",
  category: "Electronics",
  eventDate: "2026-09-01",
  latitude: 23.8,
  longitude: 90.4,
  locationLabel: LONG,
  youtubeUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 1,
  attachments: [],
};

const longComment = {
  id: "c1",
  postId: "p1",
  body: "plain comment",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  author: { id: "u3", username: LONG },
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

describe("PostDetail overflow", () => {
  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([longComment]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("breaks long titles and location labels instead of overflowing", async () => {
    const { container } = renderDetail();
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(LONG);
    expect(heading.className).toContain("break-words");
    const locationValue = container.querySelector(".col-span-2 dd");
    expect(locationValue?.textContent).toBe(LONG);
    expect(locationValue?.className).toContain("break-words");
  });

  it("truncates long comment authors without pushing the timestamp out", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText(/plain comment/)).toBeTruthy());
    const author = screen.getByText(`@${LONG}`);
    expect(author.className).toContain("truncate");
    expect(author.className).toContain("min-w-0");
  });
});

describe("PostDetail comments", () => {
  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    postsMock.addComment.mockResolvedValue({
      id: "c-new",
      postId: "p1",
      body: "new comment",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      author: { id: "u9", username: "reader" },
    });
  });

  afterEach(cleanup);

  it("comment composer enforces the 1000-char budget on send (hint + disabled, never truncated)", async () => {
    renderDetail();
    const input = await screen.findByPlaceholderText("Write a helpful comment…");
    // Deliberately no maxlength: IME composition and media-aware budgeting
    // stay intact; the budget is enforced at send time instead.
    expect(input.getAttribute("maxlength")).toBeNull();
    fireEvent.change(input, { target: { value: "x".repeat(1001) } });
    expect(await screen.findByTestId("comment-limit-hint")).toBeTruthy();
    expect(screen.getByTestId("comment-send")).toHaveProperty("disabled", true);
  });

  it("rejects submit when comment exceeds 1000 chars (defensive client-side)", async () => {
    renderDetail();
    const input = await screen.findByPlaceholderText("Write a helpful comment…");
    const longText = "x".repeat(1001);
    fireEvent.change(input, { target: { value: longText } });
    const submitButton = screen.getByTestId("comment-send");
    expect(submitButton).toHaveProperty("disabled", true);
    fireEvent.click(submitButton);
    // addComment should NOT be called
    expect(postsMock.addComment).not.toHaveBeenCalled();
  });

  it("allows submit when comment is exactly 1000 chars", async () => {
    renderDetail();
    const input = await screen.findByPlaceholderText("Write a helpful comment…");
    const exactText = "x".repeat(1000);
    fireEvent.change(input, { target: { value: exactText } });
    const submitButton = screen.getByRole("button", { name: "Send comment" });
    fireEvent.click(submitButton);
    await waitFor(() => expect(postsMock.addComment).toHaveBeenCalledTimes(1));
  });

  it("allows submit when comment is under 1000 chars", async () => {
    renderDetail();
    const input = await screen.findByPlaceholderText("Write a helpful comment…");
    fireEvent.change(input, { target: { value: "valid comment" } });
    const submitButton = screen.getByRole("button", { name: "Send comment" });
    fireEvent.click(submitButton);
    await waitFor(() => expect(postsMock.addComment).toHaveBeenCalledTimes(1));
  });

  it("rejects empty comment submit", async () => {
    renderDetail();
    await waitFor(() => screen.getByTestId("comment-send"));
    const submitButton = screen.getByTestId("comment-send");
    expect(submitButton).toHaveProperty("disabled", true);
    fireEvent.click(submitButton);
    expect(postsMock.addComment).not.toHaveBeenCalled();
  });
});

describe("PostDetail comment delete visibility", () => {
  const otherComment = {
    id: "c2",
    postId: "p1",
    body: "someone else's comment",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: "u3", username: "commenter" },
  };

  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("shows Delete to the comment author", async () => {
    authState.user = { id: "u3", username: "commenter" };
    postsMock.fetchComments.mockResolvedValue([otherComment]);
    renderDetail();
    expect(await screen.findByRole("button", { name: "Delete comment by commenter" })).toBeTruthy();
  });

  it("shows Delete to the post owner moderating another user's comment", async () => {
    authState.user = { id: "u2", username: "owner" };
    postsMock.fetchComments.mockResolvedValue([otherComment]);
    renderDetail();
    expect(await screen.findByRole("button", { name: "Delete comment by commenter" })).toBeTruthy();
  });

  it("hides Delete from an unrelated third user", async () => {
    authState.user = { id: "u9", username: "reader" };
    postsMock.fetchComments.mockResolvedValue([otherComment]);
    renderDetail();
    await waitFor(() => expect(screen.getByText(/someone else's comment/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Delete comment by commenter" })).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("PostDetail mutation locks", () => {
  let reaction: ReturnType<typeof deferred<{ postId: string; likeCount: number; dislikeCount: number; myReaction: "LIKE" | "DISLIKE" | null }>>;
  let rating: ReturnType<typeof deferred<{ postId: string; score: number; ratingAvg: number | null; ratingCount: number }>>;

  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });

    reaction = deferred();
    rating = deferred();
    postsMock.reactToPost.mockImplementation(() => reaction.promise);
    postsMock.ratePost.mockImplementation(() => rating.promise);
  });

  afterEach(cleanup);

  it("hydrates the summary from the row-derived reactionSummary, not legacy buckets", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      likeCount: 0,
      dislikeCount: 0,
      reactionSummary: { counts: { LOVE: 2, HELPFUL: 1 }, myReaction: "HELPFUL", total: 3 },
    });
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: "HELPFUL", myRating: null });
    renderDetail();
    // Row truth (3 positive reactions, one of them the caller's) wins over the
    // legacy-bucket seed, which would read 0.
    const likeButton = await screen.findByTestId("detail-like");
    expect(likeButton.getAttribute("aria-label")).toBe("Liked, 3 likes");
    expect(likeButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("sends one Like RPC on a rapid double tap and shares the lock with Not helpful", async () => {
    renderDetail();
    const likeButton = await screen.findByTestId("detail-like");
    const dislikeButton = screen.getByRole("button", { name: /Not helpful/ });
    // Same React batch also exercises the synchronous ref guard.
    act(() => {
      fireEvent.click(likeButton);
      fireEvent.click(likeButton);
      fireEvent.click(dislikeButton);
    });
    expect(postsMock.reactToPost).toHaveBeenCalledTimes(1);
    expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE");
    expect(likeButton.getAttribute("aria-pressed")).toBe("true");
    for (const button of [likeButton, dislikeButton]) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
    }
    await act(async () => reaction.resolve({ postId: "p1", likeCount: 1, dislikeCount: 0, myReaction: "LIKE" }));
    expect((likeButton as HTMLButtonElement).disabled).toBe(false);
    expect(likeButton.getAttribute("aria-busy")).toBe("false");
    expect((dislikeButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(likeButton);
    expect(postsMock.reactToPost).toHaveBeenLastCalledWith("p1", null);
  });

  it("Not helpful locks Like until the reaction settles", async () => {
    renderDetail();
    const likeButton = await screen.findByTestId("detail-like");
    const dislikeButton = screen.getByRole("button", { name: /Not helpful/ });
    fireEvent.click(dislikeButton);
    fireEvent.click(likeButton);
    expect(postsMock.reactToPost).toHaveBeenCalledTimes(1);
    expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "DISLIKE");
    expect((likeButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => reaction.resolve({ postId: "p1", likeCount: 0, dislikeCount: 1, myReaction: "DISLIKE" }));
    expect((likeButton as HTMLButtonElement).disabled).toBe(false);
    expect(dislikeButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("rolls a failed reaction back, announces it and allows retry", async () => {
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: "LIKE", myRating: null });
    render(<LiveRegion />);
    renderDetail();
    const likeButton = await screen.findByTestId("detail-like");
    await waitFor(() => expect(likeButton.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(likeButton);
    expect(likeButton.getAttribute("aria-pressed")).toBe("false");
    await act(async () => reaction.reject(new Error("Reaction could not be saved")));
    expect(likeButton.getAttribute("aria-pressed")).toBe("true");
    expect((likeButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Reaction could not be saved");
    expect(screen.getByTestId("live-region-announcement").textContent).toBe("Reaction could not be saved");
    reaction = deferred();
    fireEvent.click(likeButton);
    expect(postsMock.reactToPost).toHaveBeenCalledTimes(2);
    await act(async () => reaction.resolve({ postId: "p1", likeCount: 0, dislikeCount: 0, myReaction: null }));
  });

  it("locks every star during a rating request, then allows the next rating", async () => {
    renderDetail();
    await screen.findByRole("radiogroup", { name: /Your rating/ });
    const star3 = screen.getByRole("radio", { name: "3 stars" });
    const star5 = screen.getByRole("radio", { name: "5 stars" });
    act(() => {
      fireEvent.click(star3);
      fireEvent.click(star5);
    });
    expect(postsMock.ratePost).toHaveBeenCalledTimes(1);
    expect(postsMock.ratePost).toHaveBeenCalledWith("p1", 3);
    for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("radiogroup", { name: /Your rating/ }).getAttribute("aria-busy")).toBe("true");
    await act(async () => rating.resolve({ postId: "p1", score: 3, ratingAvg: 3, ratingCount: 1 }));
    expect(star3.getAttribute("aria-checked")).toBe("true");
    expect((star5 as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("radiogroup", { name: /Your rating/ }).getAttribute("aria-busy")).toBe("false");
    rating = deferred();
    fireEvent.click(star5);
    expect(postsMock.ratePost).toHaveBeenLastCalledWith("p1", 5);
    await act(async () => rating.resolve({ postId: "p1", score: 5, ratingAvg: 5, ratingCount: 1 }));
    expect(star5.getAttribute("aria-checked")).toBe("true");
  });

  it("restores the previous rating and announces a real failure", async () => {
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: 2 });
    render(<LiveRegion />);
    renderDetail();
    const star2 = await screen.findByRole("radio", { name: "2 stars" });
    await waitFor(() => expect(star2.getAttribute("aria-checked")).toBe("true"));
    const star5 = screen.getByRole("radio", { name: "5 stars" });
    fireEvent.click(star5);
    expect(star5.getAttribute("aria-checked")).toBe("true");
    await act(async () => rating.reject(new Error("Rating could not be saved")));
    expect(star2.getAttribute("aria-checked")).toBe("true");
    expect(star5.getAttribute("aria-checked")).toBe("false");
    expect((star5 as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Rating could not be saved");
    expect(screen.getByTestId("live-region-announcement").textContent).toBe("Rating could not be saved");
    rating = deferred();
    fireEvent.click(star5);
    expect(postsMock.ratePost).toHaveBeenCalledTimes(2);
    await act(async () => rating.resolve({ postId: "p1", score: 5, ratingAvg: 5, ratingCount: 1 }));
  });

  it("keeps owner controls locked until both independent social requests settle", async () => {
    authState.user = { id: "u2", username: "owner" };
    renderDetail();
    const likeButton = await screen.findByTestId("detail-like");
    fireEvent.click(likeButton);
    fireEvent.click(screen.getByRole("radio", { name: "3 stars" }));
    await act(async () => rating.resolve({ postId: "p1", score: 3, ratingAvg: 3, ratingCount: 1 }));
    const status = screen.getByRole("radio", { name: "Matched" });
    expect(status.getAttribute("aria-disabled")).toBe("true");
    await act(async () => reaction.resolve({ postId: "p1", likeCount: 1, dislikeCount: 0, myReaction: "LIKE" }));
    expect(status.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("PostDetail retry sequencing", () => {
  const oldComment = {
    id: "c-old",
    postId: "p1",
    body: "older retry comment",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: "u3", username: "commenter" },
  };
  const newComment = {
    id: "c-new-retry",
    postId: "p1",
    body: "newer retry comment",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    author: { id: "u4", username: "commenter2" },
  };

  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    postsMock.fetchComments.mockResolvedValue([]);
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("older in-flight comments retry cannot overwrite the newer retry result", async () => {
    postsMock.fetchComments.mockRejectedValueOnce(new Error("comments down"));
    renderDetail();
    const errorBox = await screen.findByText(/could not load comments/i);
    const retryButton = errorBox.parentElement!.querySelector("button")!;

    let resolveOlder!: (v: unknown) => void;
    let resolveNewer!: (v: unknown) => void;
    postsMock.fetchComments
      .mockImplementationOnce(() => new Promise((r) => { resolveOlder = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveNewer = r; }));

    // Two retries issued before either resolves (same generation).
    act(() => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postsMock.fetchComments).toHaveBeenCalledTimes(3);

    // Newer retry resolves first, then the older one resolves late.
    await act(async () => { resolveNewer([newComment]); });
    expect(await screen.findByText(/newer retry comment/)).toBeTruthy();
    await act(async () => { resolveOlder([oldComment]); });

    expect(screen.getByText(/newer retry comment/)).toBeTruthy();
    expect(screen.queryByText(/older retry comment/)).toBeNull();
  });

  it("older in-flight social retry cannot overwrite the newer retry result", async () => {
    postsMock.fetchSocialState.mockRejectedValueOnce(new Error("social down"));
    renderDetail();
    const errorBox = await screen.findByText(/could not load reactions/i);
    const retryButton = errorBox.parentElement!.querySelector("button")!;

    let resolveOlder!: (v: unknown) => void;
    let resolveNewer!: (v: unknown) => void;
    postsMock.fetchSocialState
      .mockImplementationOnce(() => new Promise((r) => { resolveOlder = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveNewer = r; }));

    // Two retries issued before either resolves (same generation).
    act(() => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postsMock.fetchSocialState).toHaveBeenCalledTimes(3);

    // Newer retry resolves first, then the older one resolves late.
    await act(async () => { resolveNewer({ myReaction: null, myRating: 5 }); });
    expect(await screen.findByText(/your rating: 5 out of 5/i)).toBeTruthy();
    await act(async () => { resolveOlder({ myReaction: null, myRating: 1 }); });

    expect(screen.getByText(/your rating: 5 out of 5/i)).toBeTruthy();
    expect(screen.queryByText(/your rating: 1 out of 5/i)).toBeNull();
  });

  it("older comments retry failure cannot overwrite newer retry success", async () => {
    postsMock.fetchComments.mockRejectedValueOnce(new Error("comments down"));
    renderDetail();
    const errorBox = await screen.findByText(/could not load comments/i);
    const retryButton = errorBox.parentElement!.querySelector("button")!;

    let rejectOlder!: (e: unknown) => void;
    let resolveNewer!: (v: unknown) => void;
    postsMock.fetchComments
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectOlder = rej; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveNewer = res; }));

    // Two retries issued before either settles (same generation).
    act(() => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postsMock.fetchComments).toHaveBeenCalledTimes(3);

    // Newer retry succeeds first...
    await act(async () => { resolveNewer([newComment]); });
    expect(await screen.findByText(/newer retry comment/)).toBeTruthy();

    // ...then the older retry fails late: no error may surface, content stays.
    await act(async () => { rejectOlder(new Error("stale comments failure")); });
    expect(screen.queryByText(/could not load comments/i)).toBeNull();
    expect(screen.getByText(/newer retry comment/)).toBeTruthy();
  });

  it("older social retry settling cannot clear loading while newer retry is pending", async () => {
    postsMock.fetchSocialState.mockRejectedValueOnce(new Error("social down"));
    renderDetail();
    const errorBox = await screen.findByText(/could not load reactions/i);
    const retryButton = errorBox.parentElement!.querySelector("button")!;

    let resolveOlder!: (v: unknown) => void;
    let resolveNewer!: (v: unknown) => void;
    postsMock.fetchSocialState
      .mockImplementationOnce(() => new Promise((res) => { resolveOlder = res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveNewer = res; }));

    // Two retries issued before either settles (same generation).
    act(() => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postsMock.fetchSocialState).toHaveBeenCalledTimes(3);

    // Older retry settles while the newer one is still pending: loading stays.
    await act(async () => { resolveOlder({ myReaction: null, myRating: 1 }); });
    expect(screen.getByText(/loading reactions/i)).toBeTruthy();

    // Newer retry resolves: loading clears and its result applies.
    await act(async () => { resolveNewer({ myReaction: null, myRating: 5 }); });
    expect(await screen.findByText(/your rating: 5 out of 5/i)).toBeTruthy();
    expect(screen.queryByText(/loading reactions/i)).toBeNull();
  });
});

describe("PostDetail progressive loading", () => {
  beforeEach(() => {
    postsMock.addComment.mockReset();
    postsMock.deleteComment.mockReset();
    postsMock.ratePost.mockReset();
    postsMock.reactToPost.mockReset();
    postsMock.updatePostStatus.mockReset();
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("renders the post immediately while delayed comments/social remain pending", async () => {
    let resolveComments: (v: unknown) => void = () => {};
    let resolveSocial: (v: unknown) => void = () => {};
    const commentsPromise = new Promise((r) => {
      resolveComments = r;
    });
    const socialPromise = new Promise((r) => {
      resolveSocial = r;
    });
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockImplementation(() => commentsPromise);
    postsMock.fetchSocialState.mockImplementation(() => socialPromise);

    renderDetail();

    // Fast post must not wait behind ~2s secondaries.
    const heading = await screen.findByRole("heading", { level: 1 }, { timeout: 3000 });
    expect(heading.textContent).toBe(LONG);
    // Secondary pending state is announced (stable skeleton rows hold the
    // shape); delayed comment is absent.
    expect(await screen.findByRole("status", { name: "Loading comments" })).toBeTruthy();
    expect(screen.queryByText(/plain comment/)).toBeNull();

    await act(async () => {
      resolveComments([longComment]);
      resolveSocial({ myReaction: null, myRating: null });
      await commentsPromise;
      await socialPromise;
    });
    expect(await screen.findByText(/plain comment/)).toBeTruthy();
  });

  it("shows an independent comments error without blocking the post", async () => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockRejectedValue(new Error("comments down"));
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });

    renderDetail();

    const heading = await screen.findByRole("heading", { level: 1 }, { timeout: 3000 });
    expect(heading.textContent).toBe(LONG);
    expect(await screen.findByText(/could not load comments/i)).toBeTruthy();
  });
});

describe("PostDetail shared card → detail element (Wave A)", () => {
  const photoPost = {
    ...basePost,
    title: "Lost camera",
    locationLabel: null,
    latitude: null,
    longitude: null,
    attachments: [
      {
        id: "a1",
        postId: "p1",
        fileUrl: "https://cdn.example/a1.jpg",
        mimeType: "image/jpeg",
        displayOrder: 1,
      },
    ],
  };

  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(photoPost);
    postsMock.fetchComments.mockResolvedValue([]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("carries the same shared media/title ids as the feed card", async () => {
    renderDetail();
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.getAttribute("data-shared-title")).toBe("fb-post-title-p1");
    const img = await screen.findByRole("img", { name: "Photo for Lost camera" });
    expect(img.getAttribute("data-shared-media")).toBe("fb-post-media-p1");
  });

  it("still renders content under forced reduced motion", async () => {
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter initialEntries={["/posts/p1"]}>
          <Routes>
            <Route path="/posts/:id" element={<PostDetail />} />
          </Routes>
        </MemoryRouter>
      </MotionConfig>,
    );
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Lost camera");
    expect(await screen.findByRole("img", { name: "Photo for Lost camera" })).toBeTruthy();
  });
});

describe("PostDetail threaded replies", () => {
  const parent = {
    id: "c1",
    postId: "p1",
    parentId: null,
    depth: 0,
    body: "top level",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: "u9", username: "commenter" },
  };
  const child = {
    id: "c2",
    postId: "p1",
    parentId: "c1",
    depth: 1,
    body: "nested reply",
    createdAt: "2026-09-02T00:01:00.000Z",
    updatedAt: "2026-09-02T00:01:00.000Z",
    author: { id: "u4", username: "replier" },
  };

  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([parent, child]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    postsMock.deleteComment.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("nests a reply inside its parent", async () => {
    renderDetail();
    const nested = await screen.findByText("nested reply");
    const list = nested.closest("ul");
    expect(list?.className).toContain("border-l");
  });

  it("posts a reply with the parent id and clears the reply banner", async () => {
    postsMock.addComment.mockResolvedValue({
      id: "c3",
      postId: "p1",
      parentId: "c1",
      depth: 1,
      body: "me too",
      createdAt: "2026-09-02T00:02:00.000Z",
      updatedAt: "2026-09-02T00:02:00.000Z",
      author: { id: "u9", username: "reader" },
    });
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Reply to commenter" }));
    expect(screen.getByText(/replying to/i)).toBeTruthy();

    const input = screen.getByPlaceholderText("Reply to @commenter…");
    fireEvent.change(input, { target: { value: "me too" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(postsMock.addComment).toHaveBeenCalledWith("p1", "me too", "c1"));
    await waitFor(() => expect(screen.queryByText(/replying to/i)).toBeNull());
  });

  it("removes a deleted parent's replies locally", async () => {
    renderDetail();
    await screen.findByText("nested reply");

    fireEvent.click(screen.getByRole("button", { name: "Delete comment by commenter" }));

    await waitFor(() => expect(postsMock.deleteComment).toHaveBeenCalledWith("p1", "c1"));
    await waitFor(() => {
      expect(screen.queryByText("top level")).toBeNull();
      expect(screen.queryByText("nested reply")).toBeNull();
    });
  });
});
