// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: {},
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: vi.fn() },
}));

const { postsMock, findMock, authState, realtimeHandlers } = vi.hoisted(() => ({
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
  realtimeHandlers: new Map<string, (payload: unknown) => void>(),
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
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock, applyMatchesEngineToRuntime: () => true }));

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
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 5,
  attachments: [],
};

function makeComment(
  id: string,
  username: string,
  body: string,
  parentId: string | null = null,
  depth = 0,
) {
  return {
    id,
    postId: "p1",
    parentId,
    depth,
    body,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: `u-${id}`, username },
  };
}

function renderDetail(entries: string[] = ["/posts/p1"]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route path="/posts/:id" element={<PostDetail />} />
      </Routes>
      <LiveRegion />
    </MemoryRouter>,
  );
}

function deleteButtonFor(commentId: string) {
  const row = document.getElementById(`detail-comment-${commentId}`)!;
  const trigger = within(row).getAllByRole("button", { name: /actions for comment by/i }).find(b => b.closest("li") === row)!;
  fireEvent.click(trigger);
  return within(row).getByRole("menuitem", { name: /delete comment/i });
}

describe("PostDetail inline comment threads", () => {
  beforeEach(() => {
    authState.user = { id: "u2", username: "owner" };
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 0, matches: [] });
    postsMock.deleteComment.mockResolvedValue(undefined);
    postsMock.addComment.mockImplementation(async (_postId: string, body: string, parentId: string | null) => ({
      ...makeComment("c-new", "owner", body, parentId, parentId ? 1 : 0),
    }));
    realtimeHandlers.clear();
  });

  afterEach(cleanup);

  it("renders the packet §4 row target: author + time, body, Reply and Like on touch targets", async () => {
    authState.user = { id: "u1", username: "u1" };
    postsMock.fetchComments.mockResolvedValue([makeComment("c1", "u1", "Could this be yours?")]);
    renderDetail();
    await screen.findByText("Could this be yours?");
    const row = document.getElementById("detail-comment-c1") as HTMLElement;
    expect(row).toBeTruthy();
    // Header line: author handle (+ a relative time beside it).
    expect(within(row).getByText("@u1")).toBeTruthy();
    // Actions: Reply and the Like control with its count — no picker, no tray.
    const reply = within(row).getByRole("button", { name: /reply to u1/i });
    const like = within(row).getByRole("button", { name: /like this comment/i });
    expect(like.textContent).toMatch(/\d/);
    for (const control of [reply, like]) {
      expect(control.className).toMatch(/min-h-\[4[48]px\]/);
    }
  });

  it("shows the first replies with a View N more replies count by default", async () => {    postsMock.fetchComments.mockResolvedValue([
      makeComment("r0", "rootU", "root body"),
      makeComment("r1", "u1", "reply one", "r0", 1),
      makeComment("r2", "u2a", "reply two", "r0", 1),
      makeComment("r3", "u3", "reply three", "r0", 1),
      makeComment("r4", "u4", "reply four", "r0", 1),
    ]);
    renderDetail();
    expect(await screen.findByText("reply one")).toBeTruthy();
    expect(screen.getByText("reply two")).toBeTruthy();
    expect(screen.queryByText("reply three")).toBeNull();
    expect(screen.queryByText("reply four")).toBeNull();
    expect(screen.getByRole("button", { name: /view 2 more replies/i })).toBeTruthy();
  });

  it("expands replies inline in the same thread without navigating", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("r0", "rootU", "root body"),
      makeComment("r1", "u1", "reply one", "r0", 1),
      makeComment("r2", "u2a", "reply two", "r0", 1),
      makeComment("r3", "u3", "reply three", "r0", 1),
      makeComment("r4", "u4", "reply four", "r0", 1),
    ]);
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /view 2 more replies/i }));
    const three = await screen.findByText("reply three");
    const four = screen.getByText("reply four");
    // Same list: revealed rows stay inside the root comment's <li>.
    const rootLi = document.getElementById("detail-comment-r0");
    expect(rootLi?.contains(three)).toBe(true);
    expect(rootLi?.contains(four)).toBe(true);
    // No navigation: the post shell is untouched.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Found keys");
    expect(screen.getByRole("button", { name: /hide replies/i })).toBeTruthy();
  });

  it("Hide replies collapses back to the first replies", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("r0", "rootU", "root body"),
      makeComment("r1", "u1", "reply one", "r0", 1),
      makeComment("r2", "u2a", "reply two", "r0", 1),
      makeComment("r3", "u3", "reply three", "r0", 1),
    ]);
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /view 1 more reply/i }));
    expect(await screen.findByText("reply three")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide replies/i }));
    await waitFor(() => expect(screen.queryByText("reply three")).toBeNull());
    expect(screen.getByText("reply one")).toBeTruthy();
    expect(screen.getByRole("button", { name: /view 1 more reply/i })).toBeTruthy();
  });

  it("reveals large branches incrementally", async () => {
    const replies = Array.from({ length: 9 }, (_, i) =>
      makeComment(`rk${i + 1}`, `ku${i + 1}`, `bulk reply ${i + 1}`, "r0", 1),
    );
    postsMock.fetchComments.mockResolvedValue([makeComment("r0", "rootU", "root body"), ...replies]);
    renderDetail();
    expect(await screen.findByText("bulk reply 1")).toBeTruthy();
    expect(screen.queryByText("bulk reply 3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /view 7 more replies/i }));
    expect(await screen.findByText("bulk reply 7")).toBeTruthy();
    expect(screen.queryByText("bulk reply 8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /view 2 more replies/i }));
    expect(await screen.findByText("bulk reply 9")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide replies/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /view \d+ more repl/i })).toBeNull();
  });

  it("renders depth 3 flat with an @reply-to target that jumps to the parent", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("cr", "rootU", "chain root"),
      makeComment("ca", "aU", "level one", "cr", 1),
      makeComment("cb", "bU", "level two", "ca", 2),
      makeComment("cc", "cU", "level three deep", "cb", 3),
    ]);
    renderDetail();
    const deep = await screen.findByText("level three deep");
    const jump = screen.getByRole("button", { name: /jump to parent comment by bU/i });
    expect(jump.textContent).toContain("@bU");
    // Flat: the deep row is NOT inside an indented connector (border-l) list.
    expect(deep.closest("ul")?.className).not.toContain("border-l");
    // The shallow nesting keeps its connector line.
    const shallow = screen.getByText("level one").closest("ul");
    expect(shallow?.className).toContain("border-l");
    fireEvent.click(jump);
    expect(document.getElementById("detail-comment-cb")).toBe(document.activeElement);
  });

  it("replying from a flat deep row still targets the true parent id", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("cr", "rootU", "chain root"),
      makeComment("ca", "aU", "level one", "cr", 1),
      makeComment("cb", "bU", "level two", "ca", 2),
      makeComment("cc", "cU", "level three deep", "cb", 3),
    ]);
    renderDetail();
    await screen.findByText("level three deep");
    // The Reply control lives in the flat deep row itself.
    const scope = document.getElementById("detail-comment-cc") as HTMLElement;
    fireEvent.click(within(scope).getByRole("button", { name: "Reply to cU" }));
    const input = screen.getByRole("combobox", { name: "Reply to cU" });
    fireEvent.change(input, { target: { value: "deep answer" } });
    // Submit through the composer: the write carries the true parent id.
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(postsMock.addComment).toHaveBeenCalledWith("p1", "deep answer", "cc"));
  });

  it("auto-expands ancestors for a linked-comment deep link", async () => {
    const target = "11111111-1111-4111-8111-111111111111";
    postsMock.fetchComments.mockResolvedValue([
      makeComment("r0", "rootU", "root body"),
      makeComment("r1", "u1", "reply one", "r0", 1),
      makeComment("r2", "u2a", "reply two", "r0", 1),
      makeComment("r3", "u3", "reply three", "r0", 1),
      makeComment(target, "u4", "linked reply target", "r0", 1),
    ]);
    renderDetail([`/posts/p1?comment=${target}#detail-comments`]);
    // The 4th reply is beyond the default first-replies window but must show.
    const linked = await screen.findByText("linked reply target");
    expect(linked).toBeTruthy();
    expect(screen.queryByRole("button", { name: /view \d+ more repl/i })).toBeNull();
    // Highlighted as the link target.
    expect(document.getElementById(`detail-comment-${target}`)?.className).toContain("bg-surface-container/60");
  });

  it("deleting a parent drops its expanded thread state", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const original = [
      makeComment("r1", "rootOne", "first root"),
      makeComment("r1a", "u1", "first root reply a", "r1", 1),
      makeComment("r1b", "u2a", "first root reply b", "r1", 1),
      makeComment("r2", "rootTwo", "second root"),
      makeComment("r2a", "u3", "second root reply a", "r2", 1),
      makeComment("r2b", "u4", "second root reply b", "r2", 1),
      makeComment("r2c", "u5", "second root reply c", "r2", 1),
    ];
    postsMock.fetchComments.mockResolvedValueOnce(original).mockResolvedValue(original.filter(c => c.id.startsWith("r1")));
    renderDetail();
    // Expand the second thread beyond its default window.
    const rootTwoLi = await screen.findByText("second root");
    const threadScope = document.getElementById("detail-comment-r2") as HTMLElement;
    expect(rootTwoLi).toBeTruthy();
    fireEvent.click(within(threadScope).getByRole("button", { name: /view 1 more reply/i }));
    expect(await within(threadScope).findByText("second root reply c")).toBeTruthy();
    // Delete the whole second thread (cascade, existing behavior).
    fireEvent.click(deleteButtonFor("r2"));
    await waitFor(() => expect(postsMock.deleteComment).toHaveBeenCalledWith("p1", "r2"));
    await waitFor(() => expect(screen.queryByText("second root")).toBeNull());
    expect(screen.queryByText("second root reply c")).toBeNull();
    // The surviving thread is untouched.
    expect(screen.getByText("first root reply a")).toBeTruthy();
    // Re-add a same-id thread through the authorized list, never broadcast
    // content. Its old expansion must still be forgotten.
    postsMock.fetchComments.mockResolvedValue([
      ...original.filter(c => c.id.startsWith("r1")), makeComment("r2", "rootTwo", "second root returns"),
      ...([["r2a", "u3", "returned reply a"], ["r2b", "u4", "returned reply b"], ["r2c", "u5", "returned reply c"], ["r2d", "u6", "returned reply d"]] as const)
        .map(([id, user, body]) => makeComment(id, user, body, "r2", 1)),
    ]);
    const invalidate = realtimeHandlers.get("comment:invalidate");
    expect(invalidate).toBeTruthy();
    invalidate!({ postId: "p1", invalidate: true });
    const revived = (await screen.findByText("second root returns")).closest("li") as HTMLElement;
    expect(within(revived).getByText("returned reply a")).toBeTruthy();
    expect(within(revived).queryByText("returned reply c")).toBeNull();
    expect(within(revived).getByRole("button", { name: /view 2 more replies/i })).toBeTruthy();
  });

  it("shows no view-more or hide control when a thread has exactly two replies", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("r0", "rootU", "root body"),
      makeComment("r1", "u1", "reply one", "r0", 1),
      makeComment("r2", "u2a", "reply two", "r0", 1),
    ]);
    renderDetail();
    expect(await screen.findByText("reply two")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /view \d+ more repl/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /hide replies/i })).toBeNull();
  });

  it("caps a depth-5 chain visually while keeping logical parents and true reply ids", async () => {
    postsMock.fetchComments.mockResolvedValue([
      makeComment("cr", "rootU", "chain root"),
      makeComment("ca", "aU", "level one", "cr", 1),
      makeComment("cb", "bU", "level two", "ca", 2),
      makeComment("cc", "cU", "level three", "cb", 3),
      makeComment("cd", "dU", "level four", "cc", 4),
      makeComment("ce", "eU", "level five", "cd", 5),
    ]);
    renderDetail();
    const deepest = await screen.findByText("level five");
    // Every row past the visual cap renders flat with its own @parent target.
    for (const [row, parent] of [["level three", "bU"], ["level four", "cU"], ["level five", "dU"]] as const) {
      const rowText = screen.getByText(row);
      expect(rowText.closest("ul")?.className).not.toContain("border-l");
      const jump = screen.getByRole("button", { name: new RegExp(`jump to parent comment by ${parent}`, "i") });
      expect(jump.textContent).toContain(`@${parent}`);
      expect(rowText.closest("li")?.contains(jump)).toBe(true);
    }
    // The deepest @target jumps focus to its true parent, no navigation.
    fireEvent.click(screen.getByRole("button", { name: /jump to parent comment by dU/i }));
    expect(document.getElementById("detail-comment-cd")).toBe(document.activeElement);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Found keys");
    expect(deepest).toBeTruthy();
    // Replying from the deepest flat row still writes the true parent id.
    const scope = document.getElementById("detail-comment-ce") as HTMLElement;
    fireEvent.click(within(scope).getByRole("button", { name: "Reply to eU" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Reply to eU" }), { target: { value: "deepest answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(postsMock.addComment).toHaveBeenCalledWith("p1", "deepest answer", "ce"));
  });

  it("auto-expands a collapsed branch for a depth-3 linked comment", async () => {
    const target = "22222222-2222-4222-8222-222222222222";
    postsMock.fetchComments.mockResolvedValue([
      makeComment("cr", "rootU", "chain root"),
      makeComment("cx1", "x1", "sibling one", "cr", 1),
      makeComment("cx2", "x2", "sibling two", "cr", 1),
      makeComment("ca", "aU", "level one", "cr", 1),
      makeComment("cx3", "x3", "sibling three", "cr", 1),
      makeComment("cb", "bU", "level two", "ca", 2),
      makeComment(target, "cU", "linked deep target", "cb", 3),
    ]);
    renderDetail([`/posts/p1?comment=${target}#detail-comments`]);
    // ca is the 3rd child (past the first-2 window) yet the target must show.
    const linked = await screen.findByText("linked deep target");
    expect(linked).toBeTruthy();
    expect(screen.queryByRole("button", { name: /view \d+ more repl/i })).toBeNull();
    // Highlighted as the link target and flat past the visual cap.
    expect(document.getElementById(`detail-comment-${target}`)?.className).toContain("bg-surface-container/60");
    expect(linked.closest("ul")?.className).not.toContain("border-l");
  });
});
