// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
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

function attachment(id: string, order: number) {
  return {
    id,
    mimeType: "image/jpeg",
    fileUrl: `https://cdn.example/${id}.jpg`,
    displayOrder: order,
  };
}

const basePost = {
  id: "p1",
  userId: "u2",
  author: { id: "u2", username: "owner" },
  type: "FOUND",
  status: "OPEN",
  title: "Found camera",
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
  commentCount: 0,
  attachments: [],
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

describe("PostDetail photo gallery (G17)", () => {
  beforeEach(() => {
    authState.user = { id: "u2", username: "owner" };
    postsMock.fetchComments.mockResolvedValue([]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    postsMock.updatePostStatus.mockReset();
    postsMock.updatePostStatus.mockImplementation(async (_id: string, status: string) => ({
      ...basePost,
      status,
    }));
  });

  afterEach(cleanup);

  it("renders a 1..5 gallery strip with counts instead of a single image", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2), attachment("a3", 3)],
    });
    renderDetail();

    const main = await screen.findByRole("img", { name: /photo 1 of 3/i });
    expect(main.getAttribute("src")).toContain("a1.jpg");
    expect(screen.getByText(/photo 1 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /show photo 3/i }));
    const main3 = await screen.findByRole("img", { name: /photo 3 of 3/i });
    expect(main3.getAttribute("src")).toContain("a3.jpg");
  });

  it("a single photo renders without a thumb strip", async () => {
    postsMock.fetchPost.mockResolvedValue({ ...basePost, attachments: [attachment("a1", 1)] });
    renderDetail();

    await screen.findByRole("img", { name: /photo for found camera/i });
    expect(screen.queryByRole("button", { name: /show photo/i })).toBeNull();
  });

  it("Recovered/Closed need confirmation; other transitions stay direct", async () => {
    postsMock.fetchPost.mockResolvedValue({ ...basePost, attachments: [] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderDetail();
      await screen.findByRole("radiogroup", { name: /post status/i });

      fireEvent.click(screen.getByRole("radio", { name: "Recovered" }));
      expect(confirmSpy).toHaveBeenCalled();
      expect(postsMock.updatePostStatus).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
      await waitFor(() => expect(postsMock.updatePostStatus).toHaveBeenCalledWith("p1", "CLOSED"));

      // MATCHED is not a destructive close: no confirmation.
      confirmSpy.mockClear();
      fireEvent.click(screen.getByRole("radio", { name: "Matched" }));
      await waitFor(() => expect(postsMock.updatePostStatus).toHaveBeenCalledWith("p1", "MATCHED"));
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
