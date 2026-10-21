// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function postById(id: string) {
  const isP1 = id === "p1";
  return {
    id,
    userId: "u2",
    author: { id: "u2", username: "owner" },
    type: "FOUND",
    status: "OPEN",
    title: isP1 ? "P1 title" : "P2 title",
    description: "plain description",
    category: "Electronics",
    eventDate: "2026-09-01",
    latitude: 23.8,
    longitude: 90.4,
    locationLabel: "Campus",
    youtubeUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    likeCount: isP1 ? 1 : 5,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
  };
}

function GoP2() {
  const navigate = useNavigate();
  return <button type="button" data-testid="go-p2" onClick={() => navigate("/posts/p2")}>go p2</button>;
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/posts/p1"]}>
      <Routes>
        <Route path="/posts/:id" element={<><GoP2 /><PostDetail /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.user = { id: "u9", username: "reader" };
  postsMock.fetchPost.mockImplementation(async (id: string) => postById(id));
  postsMock.fetchComments.mockResolvedValue([]);
  postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
  findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  postsMock.reactToPost.mockReset();
  postsMock.addComment.mockReset();
  postsMock.deleteComment.mockReset();
  postsMock.updatePostStatus.mockReset();
});

afterEach(cleanup);

describe("PostDetail stale mutation guard (W8-STATIC)", () => {
  it("drops a late reaction result after in-place navigation to another post", async () => {
    const reaction = deferred<{ postId: string; likeCount: number; dislikeCount: number; myReaction: "LIKE" | null }>();
    postsMock.reactToPost.mockImplementation(() => reaction.promise);

    renderDetail();
    const likeButton = await screen.findByRole("button", { name: /Like, 1 like/ });
    fireEvent.click(likeButton);
    expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE");

    // Same component instance serves the new post (the route carries no key).
    fireEvent.click(screen.getByTestId("go-p2"));
    const p2Love = await screen.findByRole("button", { name: /Like, 5 likes/ });
    expect(await screen.findByRole("heading", { name: "P2 title" })).toBeTruthy();

    await act(async () => reaction.resolve({ postId: "p1", likeCount: 99, dislikeCount: 0, myReaction: "LIKE" }));

    // p1's late truth must not rewrite p2's counts or reaction state.
    expect(p2Love.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(screen.getByRole("button", { name: /Like, 5 likes/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Liked, 99 likes/ })).toBeNull();
  });

  it("drops a late reaction result after an account switch", async () => {
    const reaction = deferred<{ postId: string; likeCount: number; dislikeCount: number; myReaction: "LIKE" | null }>();
    postsMock.reactToPost.mockImplementation(() => reaction.promise);

    const tree = (
      <MemoryRouter initialEntries={["/posts/p1"]}>
        <Routes>
          <Route path="/posts/:id" element={<PostDetail />} />
        </Routes>
      </MemoryRouter>
    );
    const rendered = render(tree);
    await screen.findByRole("button", { name: /Like, 1 like/ });
    fireEvent.click(screen.getByRole("button", { name: /Like, 1 like/ }));
    expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE");

    // Account switch does not remount the screen; the late callback for the
    // previous account must not write to the new account's view. A fresh
    // element forces the re-render a real auth-context change would drive
    // (rerendering the identical object would bail out and prove nothing).
    authState.user = { id: "uB", username: "other" };
    rendered.rerender(
      <MemoryRouter initialEntries={["/posts/p1"]}>
        <Routes>
          <Route path="/posts/:id" element={<PostDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await act(async () => reaction.resolve({ postId: "p1", likeCount: 99, dislikeCount: 0, myReaction: "LIKE" }));

    expect(screen.queryByRole("button", { name: /Liked, 99 likes/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /Liked, 2 likes/ })).toBeTruthy());
  });
});
