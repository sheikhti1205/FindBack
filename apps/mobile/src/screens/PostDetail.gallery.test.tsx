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
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock, applyMatchesEngineToRuntime: () => true }));

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

  it("renders a continuous-paging cover hero with counts and dots", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2), attachment("a3", 3)],
    });
    renderDetail();

    const track = await screen.findByTestId("detail-hero-track");
    expect(track.className).toMatch(/snap-x/);
    expect(track.className).toMatch(/snap-mandatory/);
    // No fade-only swap: every photo is mounted side by side.
    expect(screen.getByRole("img", { name: /photo 1 of 3/i }).getAttribute("src")).toContain("a1.jpg");
    expect(screen.getByRole("img", { name: /photo 2 of 3/i }).getAttribute("src")).toContain("a2.jpg");
    expect(screen.getByRole("img", { name: /photo 3 of 3/i }).getAttribute("src")).toContain("a3.jpg");
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // Chrome stays off the pixels: no overlay arrows, dots live below.
    expect(screen.queryByRole("button", { name: /previous photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /next photo/i })).toBeNull();

    // Continuous paging derives position from scroll…
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    track.scrollLeft = 300;
    fireEvent.scroll(track);
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // …and dots jump straight to a photo.
    fireEvent.click(screen.getByRole("tab", { name: /show photo 3/i }));
    expect(await screen.findByText("3 / 3")).toBeTruthy();
  });

  it("paging the hero never navigates or opens; short drags snap back", async () => {
    postsMock.fetchPost.mockResolvedValue({
      ...basePost,
      attachments: [attachment("a1", 1), attachment("a2", 2)],
    });
    renderDetail();
    await screen.findByRole("img", { name: /photo 1 of 2/i });

    const track = screen.getByTestId("detail-hero-track");
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    track.scrollLeft = 300;
    fireEvent.scroll(track);
    expect(await screen.findByText("2 / 2")).toBeTruthy();

    // A scroll that settles back on the first page restores the position.
    track.scrollLeft = 0;
    fireEvent.scroll(track);
    expect(await screen.findByText("1 / 2")).toBeTruthy();

    // The hero is a sibling of the detail content, never a navigation link.
    expect(track.closest("a")).toBeNull();
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

  it("Closed needs confirmation; Matched belongs to mutual consent, not the status picker", async () => {
    postsMock.fetchPost.mockResolvedValue({ ...basePost, attachments: [] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderDetail();
      await screen.findByRole("radiogroup", { name: /post status/i });

      // Recovered is not a status write at all: it is the durable recovery
      // relationship, which a FOUND report cannot have. The option is absent
      // rather than confirmable (PostDetail.test.tsx owns the LOST contract:
      // the picker opens and no bare status is written).
      expect(screen.queryByRole("radio", { name: "Recovered" })).toBeNull();
      expect(screen.queryByRole("radio", { name: "Matched" })).toBeNull();

      // Closed is terminal for the searcher: a declined confirm writes nothing.
      fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
      expect(confirmSpy).toHaveBeenCalled();
      expect(postsMock.updatePostStatus).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
      await waitFor(() => expect(postsMock.updatePostStatus).toHaveBeenCalledWith("p1", "CLOSED"));

    } finally {
      confirmSpy.mockRestore();
    }
  });
});
