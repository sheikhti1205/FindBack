// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postsMock, findMock } = vi.hoisted(() => ({
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
}));

vi.mock("../services/posts", () => postsMock);
vi.mock("../services/realtime", () => ({
  joinPostRoom: vi.fn(),
  leavePostRoom: vi.fn(),
  onRealtime: vi.fn(() => () => {}),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u9", username: "reader" } }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock }));

import { PostDetail } from "./PostDetail";

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

describe("PostDetail overflow (WP15 #37)", () => {
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
