// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  authState: { user: { id: "u2", username: "owner" } as { id: string; username: string } | null },
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
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 2,
  attachments: [],
};

function makeComment(id: string, username: string, body: string, avatarUrl?: string | null) {
  return {
    id,
    postId: "p1",
    parentId: null,
    depth: 0,
    body,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: `u-${id}`, username, avatarUrl: avatarUrl ?? null },
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/posts/p1"]}>
      <Routes>
        <Route path="/posts/:id" element={<PostDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PostDetail comment identity (W7)", () => {
  beforeEach(() => {
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("shows the canonical UserAvatar beside each comment author", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("c1", "helper", "try the library desk", "https://example.com/h.png"),
      makeComment("c2", "plain", "good luck"),
    ]);
    renderDetail();

    await screen.findByText("try the library desk");
    const row1 = document.getElementById("detail-comment-c1")!;
    const avatar1 = within(row1).getByTestId("user-avatar");
    expect((avatar1.querySelector("img") as HTMLImageElement)?.src).toBe("https://example.com/h.png");

    const row2 = document.getElementById("detail-comment-c2")!;
    expect(within(row2).getByTestId("user-avatar").textContent).toBe("PL");
  });

  it("shows the signed-in user's avatar in the comment composer", async () => {
    authState.user = {
      id: "u9",
      username: "commenter",
      avatarUrl: "https://example.com/me.png",
    } as { id: string; username: string };
    postsMock.fetchComments.mockResolvedValue([makeComment("c1", "helper", "try the library desk")]);
    renderDetail();

    const input = await screen.findByLabelText("Comment");
    const composer = screen.getByTestId("comment-composer");
    expect(composer.contains(input)).toBe(true);
    const composerAvatar = within(composer).getByTestId("user-avatar");
    expect((composerAvatar.querySelector("img") as HTMLImageElement)?.src).toBe(
      "https://example.com/me.png",
    );
    authState.user = { id: "u2", username: "owner" } as { id: string; username: string };
  });

  it("keeps @username, time, and the Like control on avatar rows", async () => {
    postsMock.fetchComments.mockResolvedValue([makeComment("c1", "helper", "try the library desk")]);
    renderDetail();

    await screen.findByText("try the library desk");
    const row = document.getElementById("detail-comment-c1")!;
    expect(within(row).getByText("@helper")).toBeTruthy();
    expect(within(row).getByTestId("comment-react-c1")).toBeTruthy();
    // Like-only: the comment chevron/tray is gone (packet 08 §2).
    expect(within(row).queryByTestId("comment-choose-c1")).toBeNull();
  });
});
