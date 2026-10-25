// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { posts, viewer, handlers, report } = vi.hoisted(() => ({
  posts: { fetchPost: vi.fn(), fetchComments: vi.fn(), fetchSocialState: vi.fn(), addComment: vi.fn(),
    deleteComment: vi.fn(), reactToPost: vi.fn(), updatePostStatus: vi.fn() },
  viewer: { user: { id: "reader", username: "reader" } },
  handlers: new Map<string, (p: Record<string, unknown>) => void>(), report: vi.fn(),
}));
vi.mock("../services/posts", () => posts);
vi.mock("../auth", () => ({ useAuth: () => viewer }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: async () => ({ available: true, candidatesConsidered: 0, matches: [] }), applyMatchesEngineToRuntime: () => true }));
vi.mock("../services/realtime", () => ({ joinPostRoom: vi.fn(), leavePostRoom: vi.fn(),
  onRealtime: (e: string, h: (p: Record<string, unknown>) => void) => { handlers.set(e, h); return () => { handlers.delete(e); }; },
}));
vi.mock("../services/moderation", async (original) => ({
  ...await original<typeof import("../services/moderation")>(), submitReport: (...args: unknown[]) => report(...args),
}));
import { PostDetail } from "./PostDetail";
const post = { id: "p1", userId: "owner", author: { id: "owner", username: "owner" }, type: "FOUND", status: "OPEN",
  title: "Keys", description: "Description", category: "Electronics", eventDate: "2026-10-24", latitude: null, longitude: null,
  locationLabel: null, youtubeUrl: null, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
  likeCount: 0, dislikeCount: 0, ratingAvg: null, ratingCount: 0, commentCount: 1, attachments: [] };
function comment(id: string, body = id) { return { id, postId: "p1", parentId: null, depth: 0, body,
  author: { id: "author", username: "helper" }, createdAt: post.createdAt, updatedAt: post.updatedAt }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tree = () => <MemoryRouter initialEntries={["/posts/p1"]}><Routes><Route path="/posts/:id" element={<PostDetail />} /></Routes></MemoryRouter>;
const emit = (e = "comment:invalidate", postId = "p1", op?: string) => act(() => {
  handlers.get(e)?.({ postId, invalidate: true, ...(op ? { op } : {}) });
});
beforeEach(() => {
  vi.clearAllMocks(); posts.fetchComments.mockReset(); handlers.clear(); viewer.user = { id: "reader", username: "reader" };
  posts.fetchPost.mockResolvedValue(post); posts.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
  posts.fetchComments.mockResolvedValue([comment("c1", "Original comment")]); report.mockResolvedValue({ reportId: "r1" });
});
afterEach(cleanup);

it("a moderation invalidation conceals unverified media and keeps the reply target until the list answers", async () => {
  posts.fetchComments.mockResolvedValueOnce([comment("c1", "Original comment\n![photo](https://fixture.supabase.co/storage/v1/object/public/findback-comment-media/author/photo.jpg)")]);
  const pending = deferred<ReturnType<typeof comment>[]>();
  render(tree()); await screen.findByText("Original comment");
  expect(screen.getByAltText(/Attached photo/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reply to helper" }));
  expect(screen.getByRole("button", { name: /cancel reply/i })).toBeTruthy();
  posts.fetchComments.mockReturnValue(pending.promise);
  emit("comment:invalidate", "p1", "MODERATION");
  await waitFor(() => expect(posts.fetchComments).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Original comment")).toBeNull();
  expect(screen.queryByAltText(/Attached photo/)).toBeNull();
  // The chosen reply target is not a broadcast-supplied fact to destroy: it
  // survives until the authorized list proves the parent is gone.
  expect(screen.getByRole("button", { name: /cancel reply/i })).toBeTruthy();
  await act(async () => pending.resolve([comment("c2", "Authorized sibling")]));
  expect(await screen.findByText("Authorized sibling")).toBeTruthy();
  expect(screen.queryByText("Original comment")).toBeNull();
  expect(screen.queryByRole("button", { name: /cancel reply/i })).toBeNull();
});

it("an INSERT or reaction invalidation is a quiet refetch that keeps the visible conversation", async () => {
  render(tree()); await screen.findByText("Original comment");
  fireEvent.click(screen.getByRole("button", { name: "Reply to helper" }));
  posts.fetchComments.mockResolvedValue([
    comment("c1", "Original comment"),
    comment("c2", "Someone else replied"),
  ]);
  emit("comment:invalidate", "p1", "INSERT");
  expect(await screen.findByText("Someone else replied")).toBeTruthy();
  expect(screen.getByText("Original comment")).toBeTruthy();
  expect(screen.getByRole("button", { name: /cancel reply/i })).toBeTruthy();
});
it("a slower invalidated read cannot resurrect a comment the newer refetch dropped", async () => {
  render(tree()); await screen.findByText("Original comment");
  const older = deferred<ReturnType<typeof comment>[]>();
  posts.fetchComments.mockReturnValueOnce(older.promise).mockResolvedValueOnce([]);
  emit(); emit();
  await waitFor(() => expect(posts.fetchComments).toHaveBeenCalledTimes(3));
  await act(async () => older.resolve([comment("c1", "Stale secret")]));
  expect(screen.queryByText("Stale secret")).toBeNull();
});
it("ignores another report and has no legacy comment broadcast consumer at all", async () => {
  render(tree()); await screen.findByText("Original comment");
  emit("comment:invalidate", "p2");
  // The removed public `comment:added` event has no subscriber: a forged body
  // cannot reach the list because nothing is listening, not because the payload
  // happened to be shaped unexpectedly.
  expect(handlers.has("comment:added")).toBe(false);
  expect(posts.fetchComments).toHaveBeenCalledTimes(1);
});
it("account switch clears old comments immediately, refetches and fences the prior account read", async () => {
  const r = render(tree()); await screen.findByText("Original comment");
  const older = deferred<ReturnType<typeof comment>[]>(); const next = deferred<ReturnType<typeof comment>[]>();
  posts.fetchComments.mockReturnValueOnce(older.promise).mockReturnValueOnce(next.promise);
  emit(); viewer.user = { id: "other", username: "other" }; r.rerender(tree());
  await act(async () => older.resolve([comment("c1", "Prior account data")]));
  expect(screen.queryByText("Prior account data")).toBeNull();
  expect(screen.queryByText("Original comment")).toBeNull();
  await act(async () => next.resolve([comment("c2", "New account result")]));
  expect(await screen.findByText("New account result")).toBeTruthy();
});
it("report success conceals the exact comment immediately even when the refetch stalls", async () => {
  posts.fetchComments.mockResolvedValueOnce([comment("c1", "Original comment"), { ...comment("c2", "Unrelated sibling"), author: { id: "other-author", username: "other-helper" } }]);
  render(tree()); await screen.findByText("Original comment");
  posts.fetchComments.mockReturnValue(new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Actions for comment by helper" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Report comment" }));
  fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
  fireEvent.click(screen.getByRole("button", { name: /send report/i }));
  await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText("Original comment")).toBeNull());
  expect(screen.getByText("Unrelated sibling")).toBeTruthy();
  expect(posts.fetchComments).toHaveBeenCalledTimes(2);
});
it("focus and reaction invalidation also reconcile authorized counts/content", async () => {
  render(tree()); await screen.findByText("Original comment");
  posts.fetchComments.mockResolvedValue([]);
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(posts.fetchComments).toHaveBeenCalledTimes(2));
  emit("reaction:invalidate");
  await waitFor(() => expect(posts.fetchComments).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("Original comment")).toBeNull();
});
it("successful creation reconciles through the authorized reader instead of appending the writer response", async () => {
  render(tree()); await screen.findByText("Original comment");
  posts.addComment.mockResolvedValue(comment("new", "No longer authorized writer response"));
  posts.fetchComments.mockResolvedValue([]);
  fireEvent.change(screen.getByRole("combobox", { name: "Comment" }), { target: { value: "New text" } });
  fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await waitFor(() => expect(posts.addComment).toHaveBeenCalledWith("p1", "New text", null));
  await waitFor(() => expect(posts.fetchComments).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("No longer authorized writer response")).toBeNull();
});
it("an unavailable authorized refetch cannot leave the old body visible", async () => {
  render(tree()); await screen.findByText("Original comment");
  posts.fetchComments.mockRejectedValue(new Error("Offline")); emit();
  await screen.findByText(/Could not load comments/);
  expect(screen.queryByText("Original comment")).toBeNull();
});
