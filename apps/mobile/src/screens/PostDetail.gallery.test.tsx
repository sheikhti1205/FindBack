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

  it("renders a swipeable cover hero with counts and dots", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2), attachment("a3", 3)],
    });
    renderDetail();

    const main = await screen.findByRole("img", { name: /photo 1 of 3/i });
    expect(main.getAttribute("src")).toContain("a1.jpg");
    expect(main.className).toContain("object-cover");
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next photo/i }));
    const main2 = await screen.findByRole("img", { name: /photo 2 of 3/i });
    expect(main2.getAttribute("src")).toContain("a2.jpg");
    expect(screen.getByText("2 / 3")).toBeTruthy();

    // Dots jump straight to a photo.
    fireEvent.click(screen.getByRole("tab", { name: /show photo 3/i }));
    const main3 = await screen.findByRole("img", { name: /photo 3 of 3/i });
    expect(main3.getAttribute("src")).toContain("a3.jpg");
  });

  it("swiping the hero changes the photo; vertical drags do not", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2)],
    });
    renderDetail();
    await screen.findByRole("img", { name: /photo 1 of 2/i });

    const stage = screen.getByTestId("detail-hero-stage");
    fireEvent.touchStart(stage, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 80, clientY: 105 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 80, clientY: 105 }] });
    expect(await screen.findByRole("img", { name: /photo 2 of 2/i })).toBeTruthy();

    // Mostly-vertical gesture: page scroll wins, photo stays.
    fireEvent.touchStart(stage, { touches: [{ clientX: 150, clientY: 50 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 140, clientY: 250 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 140, clientY: 250 }] });
    expect(screen.getByRole("img", { name: /photo 2 of 2/i })).toBeTruthy();
  });

  it("tapping the hero opens the fullscreen lightbox", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2)],
    });
    renderDetail();
    await screen.findByRole("img", { name: /photo 1 of 2/i });
    fireEvent.click(screen.getByRole("button", { name: /open photo 1 of 2 fullscreen/i }));
    expect(await screen.findByTestId("photo-lightbox")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Photo 1 of 2" })).toBeTruthy();
  });

  it("a single photo renders a cover hero without nav controls", async () => {
    postsMock.fetchPost.mockResolvedValue({ ...basePost, attachments: [attachment("a1", 1)] });
    renderDetail();

    const img = await screen.findByRole("img", { name: /photo for found camera/i });
    expect(img.className).toContain("object-cover");
    expect(screen.queryByRole("button", { name: /next photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /previous photo/i })).toBeNull();
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
