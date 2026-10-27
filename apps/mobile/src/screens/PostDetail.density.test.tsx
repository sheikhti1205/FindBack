// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: {},
}));

const { postsMock, findMock, authState, submitReport } = vi.hoisted(() => ({
  submitReport: vi.fn(),
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
vi.mock("../services/moderation", async (original) => ({
  ...await original<typeof import("../services/moderation")>(), submitReport,
}));
vi.mock("../services/realtime", () => ({
  joinPostRoom: vi.fn(),
  leavePostRoom: vi.fn(),
  onRealtime: vi.fn(() => () => {}),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock, applyMatchesEngineToRuntime: () => true }));

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
  it("reports the loaded post through an overflow outside the four social slots", async () => {
    renderDetail();
    const trigger = await screen.findByRole("button", { name: "More report actions" });
    expect(trigger.closest('[data-testid="post-action-row"]')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Report post" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByTestId("report-receipt");
    expect(submitReport).toHaveBeenCalledWith(
      { targetType: "POST", targetId: "p1", reason: "HARASSMENT", detail: null },
      expect.any(AbortSignal),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: "u9", username: "reader" };
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([comment]);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    submitReport.mockResolvedValue({ reportId: "receipt" });
    postsMock.deleteComment.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("reports the actual comment through the unified overflow and sheet", async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for comment by neighbour" }));
    expect(screen.queryByRole("menuitem", { name: "Delete comment" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report comment" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByTestId("report-receipt");
    expect(submitReport).toHaveBeenCalledWith(
      { targetType: "COMMENT", targetId: "c1", reason: "HARASSMENT", detail: null },
      expect.any(AbortSignal),
    );
  });

  it("targets a nested reply, not its parent, when reporting", async () => {
    postsMock.fetchComments.mockResolvedValue([comment, {
      ...comment, id: "reply-1", parentId: "c1", body: "Nested reply",
      author: { id: "u4", username: "helper" },
    }]);
    renderDetail();
    const body = await screen.findByText("Nested reply");
    const reply = body.closest("li")!;
    fireEvent.click(within(reply).getByRole("button", { name: "Actions for comment by helper" }));
    fireEvent.click(within(reply).getByRole("menuitem", { name: "Report comment" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByTestId("report-receipt");
    expect(submitReport).toHaveBeenCalledWith(
      { targetType: "COMMENT", targetId: "reply-1", reason: "HARASSMENT", detail: null },
      expect.any(AbortSignal),
    );
  });

  it("never exposes comment moderation actions to a signed-out viewer", async () => {
    authState.user = null;
    renderDetail();
    await screen.findByText("first comment");
    expect(screen.queryByRole("button", { name: /Actions for comment by/i })).toBeNull();
    expect(postsMock.deleteComment).not.toHaveBeenCalled();
    expect(submitReport).not.toHaveBeenCalled();
  });

  it("offers self Delete without self Report and respects cancellation", async () => {
    authState.user = { id: "u3", username: "neighbour" };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for comment by neighbour" }));
    expect(screen.queryByRole("menuitem", { name: "Report comment" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
    expect(confirm).toHaveBeenCalled();
    expect(postsMock.deleteComment).not.toHaveBeenCalled();
    expect(screen.getByText("first comment")).toBeTruthy();
  });

  it("lets the report owner delete through the same menu and server write", async () => {
    authState.user = { id: "u2", username: "owner" };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for comment by neighbour" }));
    expect(screen.getByRole("menuitem", { name: "Report comment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByText("first comment")).toBeNull());
    expect(postsMock.deleteComment).toHaveBeenCalledWith("p1", "c1");
  });

  it("keeps confirmed parent and descendants hidden across clean and stale refetches", async () => {
    authState.user = { id: "u2", username: "owner" };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const reply = { ...comment, id: "reply", parentId: "c1", body: "deleted reply", author: { id: "u4", username: "helper" } };
    const sentinel = { ...comment, id: "other", body: "unaffected comment" };
    const fresh = { ...comment, id: "new", body: "new comment" };
    const rows = [comment, reply, sentinel];
    let resolvePending!: (value: typeof rows) => void;
    const pending = new Promise<typeof rows>((resolve) => { resolvePending = resolve; });
    postsMock.fetchComments.mockResolvedValueOnce(rows).mockReturnValueOnce(pending)
      .mockResolvedValueOnce([sentinel]).mockResolvedValueOnce([...rows, fresh]);
    renderDetail();
    await screen.findByText("deleted reply");
    fireEvent.focus(window);
    expect(postsMock.fetchComments).toHaveBeenCalledTimes(2);
    fireEvent.click(within(screen.getByText("first comment").closest("li")!).getByRole("button", { name: "Actions for comment by neighbour" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
    await waitFor(() => expect(postsMock.fetchComments).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("deleted reply")).toBeNull());
    await act(async () => { resolvePending(rows); await pending; });
    expect(screen.queryByText("first comment")).toBeNull();
    expect(screen.getByText("unaffected comment")).toBeTruthy();
    fireEvent.focus(window);
    await screen.findByText("new comment");
    expect(screen.queryByText("first comment")).toBeNull();
    expect(screen.queryByText("deleted reply")).toBeNull();
    expect(screen.getByText("unaffected comment")).toBeTruthy();
  });

  it("retains a comment when the server refuses deletion", async () => {
    authState.user = { id: "u3", username: "neighbour" };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    postsMock.deleteComment.mockRejectedValue(new Error("offline"));
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Actions for comment by neighbour" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
    await screen.findByRole("alert");
    expect(screen.getByText("first comment")).toBeTruthy();
  });

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
