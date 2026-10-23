// @vitest-environment jsdom
import { createContext, useContext } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedPage, PostItem, PublicProfile as PublicProfileShape } from "@findback/shared";

const api = vi.hoisted(() => ({ profile: vi.fn(), feed: vi.fn() }));
vi.mock("../services/profile", async (original) => ({
  ...await original<typeof import("../services/profile")>(), fetchPublicProfile: api.profile,
}));
vi.mock("../services/posts", () => ({ fetchFeed: api.feed }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: useContext(Viewer) }) }));
const Viewer = createContext<{ id: string } | null>({ id: "viewer-a" });
import { PublicProfile } from "./PublicProfile";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function member(username: string): PublicProfileShape {
  return { id: username, username, displayName: username, bio: null, avatarUrl: null,
    locationLabel: null, emailVerified: false, phoneVerified: false, createdAt: "2026-01-01" };
}
function report(id: string, blockedAuthor = false): PostItem {
  return { id, userId: "owner", author: member("owner"), type: "FOUND", title: id,
    description: "A wallet with a broken clasp", category: "Bags & Wallets", status: "OPEN",
    eventDate: "2026-01-01", latitude: null, longitude: null, locationLabel: null, youtubeUrl: null,
    attachments: [], likeCount: 0, dislikeCount: 0, ratingAvg: null, ratingCount: 0, commentCount: 0,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", blockedAuthor };
}
function page(id: string, nextCursor: string | null = null, blockedAuthor = false): FeedPage {
  return { items: [report(id, blockedAuthor)], nextCursor, total: 3 };
}
function NavigateProfiles() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate("/u/other")}>View other profile</button>
    <button onClick={() => navigate("/u/owner")}>View owner profile</button></>;
}
function Harness({ viewer = "viewer-a" }: { viewer?: string | null }) {
  return <Viewer.Provider value={viewer ? { id: viewer } : null}>
    <MemoryRouter initialEntries={["/u/owner"]}>
      <NavigateProfiles />
      <Routes><Route path="/u/:username" element={<PublicProfile />} /></Routes>
    </MemoryRouter>
  </Viewer.Provider>;
}

beforeEach(() => {
  api.profile.mockReset().mockImplementation(async (username: string) => member(username));
  api.feed.mockReset();
});
afterEach(cleanup);

describe("PublicProfile request lifetime", () => {
  it.each(["resolve", "reject"] as const)("ignores a previous handle's pending page %s", async (settlement) => {
    const oldPage = deferred<FeedPage>();
    api.feed.mockResolvedValueOnce(page("Owner first", "owner-cursor"))
      .mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(page("Other first", "other-cursor"));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more reports" }));
    fireEvent.click(screen.getByRole("button", { name: "View other profile" }));
    await screen.findByRole("link", { name: "Other first" });
    await act(async () => {
      if (settlement === "resolve") oldPage.resolve(page("Stale owner page"));
      else oldPage.reject(new Error("old transport failed"));
    });
    expect(screen.queryByRole("link", { name: "Stale owner page" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const more = screen.getByRole("button", { name: "Load more reports" });
    expect((more as HTMLButtonElement).disabled).toBe(false);
    api.feed.mockResolvedValueOnce(page("Other second"));
    fireEvent.click(more);
    await screen.findByRole("link", { name: "Other second" });
    expect(api.feed).toHaveBeenLastCalledWith({ userId: "other" }, "other-cursor");
  });

  it("does not revive page work after owner → other → owner", async () => {
    const oldPage = deferred<FeedPage>();
    api.feed.mockResolvedValueOnce(page("Old owner", "old-cursor")).mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page("Other first")).mockResolvedValueOnce(page("Fresh owner", "fresh-cursor"));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more reports" }));
    fireEvent.click(screen.getByRole("button", { name: "View other profile" }));
    await screen.findByRole("link", { name: "Other first" });
    fireEvent.click(screen.getByRole("button", { name: "View owner profile" }));
    await screen.findByRole("link", { name: "Fresh owner" });
    await act(async () => { oldPage.resolve(page("Stale owner page")); });
    expect(screen.queryByRole("link", { name: "Stale owner page" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load more reports" })).toBeTruthy();
  });

  it.each(["viewer-b", null])("reloads same-handle viewer-dependent flags for %s and drops old page work", async (viewer) => {
    const oldPage = deferred<FeedPage>();
    const freshPage = deferred<FeedPage>();
    api.feed.mockResolvedValueOnce(page("Prior viewer row", "old-cursor"))
      .mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(freshPage.promise);
    const view = render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more reports" }));
    view.rerender(<Harness viewer={viewer} />);
    expect(screen.queryByRole("link", { name: "Prior viewer row" })).toBeNull();
    expect(await screen.findByText("Loading profile…")).toBeTruthy();
    await act(async () => { freshPage.resolve(page("Fresh viewer row", null, true)); });
    await screen.findByTestId("blocked-shield");
    expect(screen.queryByRole("link", { name: "Fresh viewer row" })).toBeNull();
    await act(async () => { oldPage.resolve(page("Old viewer late page")); });
    expect(screen.queryByText("Old viewer late page")).toBeNull();
    expect(api.profile).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending initial feed after a viewer change", async () => {
    const oldFirst = deferred<FeedPage>();
    api.feed.mockReturnValueOnce(oldFirst.promise).mockResolvedValueOnce(page("New viewer first"));
    const view = render(<Harness />);
    await screen.findByText("@owner");
    view.rerender(<Harness viewer="viewer-b" />);
    await screen.findByRole("link", { name: "New viewer first" });
    await act(async () => { oldFirst.resolve(page("Old viewer initial")); });
    expect(screen.queryByRole("link", { name: "Old viewer initial" })).toBeNull();
  });
});
