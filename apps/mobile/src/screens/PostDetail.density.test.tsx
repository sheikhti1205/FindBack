// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: {},
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

const basePost = {
  id: "p1",
  userId: "u2",
  author: { id: "u2", username: "owner" },
  type: "FOUND",
  status: "OPEN",
  title: "Lost keys",
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
  dislikeCount: 0,
  ratingAvg: 4.5,
  ratingCount: 2,
  commentCount: 2,
  attachments: [],
};

const comment = {
  id: "c1",
  postId: "p1",
  body: "first comment",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  author: { id: "u3", username: "neighbour" },
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

describe("PostDetail density (owner wave)", () => {
  beforeEach(() => {
    authState.user = { id: "u9", username: "reader" };
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([comment]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
  });

  afterEach(cleanup);

  it("puts like, comments, share and save in ONE flat action row", async () => {
    renderDetail();
    const row = await screen.findByTestId("post-action-row");
    // One group, no bordered button cards: the row is the action surface.
    expect(row.getAttribute("role")).toBe("group");
    expect(row.getAttribute("aria-label")).toBe("Report actions");
    // Every action of the reference row is reachable from it.
    expect(row.querySelector('[data-testid="detail-like"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="save-report-button"]')).not.toBeNull();
    expect(row.querySelector('[aria-label^="Comments"]')).not.toBeNull();
    expect(row.querySelector('[aria-label="Share report"]')).not.toBeNull();
    // The old three-cell grid is gone.
    expect(screen.queryByRole("group", { name: "Report actions" })?.getAttribute("class")).not.toContain(
      "grid-cols-3",
    );
  });

  it("renders a comment as a flat row, not as its own bordered card", async () => {
    renderDetail();
    const body = await screen.findByText("first comment");
    const row = body.closest("li");
    expect(row).not.toBeNull();
    // No card chrome around a comment: no border, no background fill, no
    // padding box. Separation is whitespace.
    expect(row?.className ?? "").not.toContain("border-outline-variant");
    expect(row?.className ?? "").not.toContain("rounded-m3-md");
    expect(row?.className ?? "").not.toContain("p-3");
  });

  it("keeps the write bar at the END of the thread, not above it", async () => {
    renderDetail();
    const body = await screen.findByText("first comment");
    const composer = await screen.findByLabelText("Comment");
    // The composer comes after the last comment in reading order.
    expect(
      body.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("marks the report author on their own comment", async () => {
    postsMock.fetchComments.mockResolvedValue([
      { ...comment, id: "c2", author: { id: "u2", username: "owner" } },
    ]);
    renderDetail();
    expect(await screen.findByText("Author")).toBeTruthy();
  });

  it("does not mark another participant as the report author", async () => {
    renderDetail();
    await screen.findByText("first comment");
    expect(screen.queryByText("Author")).toBeNull();
  });

  it("keeps reply context and cancel beside the end-of-thread composer", async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /reply to neighbour/i }));
    const composer = screen.getByRole("combobox", { name: "Reply to neighbour" });
    const anchor = composer.closest(".sticky");
    expect(anchor).not.toBeNull();
    const cancel = within(anchor as HTMLElement).getByRole("button", { name: "Cancel reply" });
    expect(within(anchor as HTMLElement).getByRole("status").textContent).toContain("@neighbour");
    fireEvent.click(cancel);
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
    expect(screen.getByLabelText("Comment")).toBeTruthy();
  });
});
