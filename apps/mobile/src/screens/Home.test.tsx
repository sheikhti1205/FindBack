// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categoryValue, chooseCategory } from "../test-utils/reportCategory";

const { fetchFeedMock, handlers, onRealtimeMock, tabTapState } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    fetchFeedMock: vi.fn(),
    handlers,
    tabTapState: { tapCount: 0 },
    onRealtimeMock: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
  };
});

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../services/realtime", () => ({ onRealtime: onRealtimeMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));
vi.mock("../components/PostList", () => ({
  PostList: ({ items, error, emptySubtitle, onRetry }: { items: Array<{ id: string }>; error: string | null; emptySubtitle: string; onRetry: () => Promise<void> }) => (
    <div>
      {error ? <><p role="alert">{error}</p><button onClick={() => void onRetry()}>Try again</button></> : null}
      {!error && items.length === 0 ? <p>{emptySubtitle}</p> : null}
      <ul data-testid="posts">{items.map((i) => <li key={i.id}>{i.id}</li>)}</ul>
    </div>
  ),
}));

import { Home } from "./Home";
import { buildFeedCacheKey, clearFeedCaches, saveFeedCache } from "../hooks/feedCache";
import { consumeBackIntercept, resetBackInterceptors } from "../components/backNavigation";

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function renderHome(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Home />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("Home realtime", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    onRealtimeMock.mockClear();
    handlers.clear();
    tabTapState.tapCount = 0;
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({
      items: ["a", "b", "c"].map((id) => ({ id, title: id })),
      nextCursor: null,
      total: 3,
    });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
    resetBackInterceptors();
  });

  it("reconciles a deleted post in place without refetching", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fetchFeedMock.mockClear();

    act(() => emit("post:deleted", { postId: "b", op: "DELETE" }));

    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("ignores a provable non-member insert under a type filter", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "Lost" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ type: "LOST" }), undefined),
    );
    fetchFeedMock.mockClear();

    act(() =>
      emit("feed:changed", {
        change: "INSERT",
        op: "INSERT",
        postId: "x",
        postType: "FOUND",
        title: "Found keys",
      }),
    );

    expect(fetchFeedMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/new post/i)).toBeNull();
    expect(screen.queryByText(/^updates$/i)).toBeNull();
  });

  it("refreshes for a matching insert under a type filter", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "Lost" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ type: "LOST" }), undefined),
    );
    fetchFeedMock.mockClear();

    act(() =>
      emit("feed:changed", {
        change: "INSERT",
        op: "INSERT",
        postId: "y",
        postType: "LOST",
        title: "Lost wallet",
      }),
    );

    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
  });

  it("shows Updates, not a count, when a search query makes membership unprovable", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "wallet" } });
    await waitFor(
      () => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "wallet" }), undefined),
      { timeout: 3000 },
    );

    // Scroll the reader down, then receive an insert.
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    (scroller as HTMLElement).scrollTop = 100;

    act(() =>
      emit("feed:changed", {
        change: "INSERT",
        op: "INSERT",
        postId: "z",
        postType: "LOST",
        title: "Lost wallet",
      }),
    );

    expect(await screen.findByText(/^updates$/i)).toBeTruthy();
    expect(screen.queryByText(/new post/i)).toBeNull();
  });

  it("restores the type filter from the URL on mount", async () => {
    renderHome("/?type=LOST");
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ type: "LOST" }), undefined),
    );
    expect(screen.getByRole("radio", { name: "Lost" }).getAttribute("aria-checked")).toBe("true");
  });

  it("restores the search query from the URL on mount", async () => {
    renderHome("/?q=wallet");
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("wallet");
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "wallet" }), undefined),
    );
  });

  it("writes filter edits back to the URL", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "Lost" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/?type=LOST"));

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "wallet" } });
    await waitFor(
      () => expect(screen.getByTestId("location").textContent).toBe("/?type=LOST&q=wallet"),
      { timeout: 3000 },
    );
  });

  it("exposes category, status and sort in Home filters and applies them to the feed and URL", async () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));
    await chooseCategory("Electronics");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "OPEN" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "oldest" } });

    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: "Electronics", status: "OPEN", sort: "oldest" }), undefined,
    ));
    await waitFor(() => {
      const params = new URLSearchParams(screen.getByTestId("location").textContent?.split("?")[1]);
      expect(params.get("category")).toBe("Electronics");
      expect(params.get("status")).toBe("OPEN");
      expect(params.get("sort")).toBe("oldest");
    });
    expect(categoryValue()).toBe("Electronics");
  });

  it("restores Home advanced filters and clears them without dropping q or type", async () => {
    renderHome("/?type=FOUND&q=phone&category=Electronics&status=OPEN&sort=oldest");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FOUND", q: "phone", category: "Electronics", status: "OPEN", sort: "oldest" }), undefined,
    ));
    fireEvent.click(screen.getByRole("button", { name: /clear all filters/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/?type=FOUND&q=phone"));
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FOUND", q: "phone", category: undefined, status: undefined, sort: "newest" }), undefined,
    ));
  });

  it("offers Create report on the unfiltered empty feed", async () => {
    fetchFeedMock.mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 });
    renderHome();
    expect(await screen.findByText(/Tap Create report/)).toBeTruthy();
  });

  it("suggests broader search when advanced filters find no results", async () => {
    fetchFeedMock.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    renderHome("/?category=Electronics&status=OPEN");
    expect(await screen.findByText("Try different filters or a broader search.")).toBeTruthy();
  });

  it("preserves retry on an empty-feed error", async () => {
    fetchFeedMock.mockRejectedValueOnce(new Error("network down"));
    renderHome();
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(2));
  });

  it("restores filtered results from the detail-to-Home session cache", async () => {
    const entry = "/?type=LOST&category=Electronics&status=OPEN&sort=oldest&q=wallet";
    saveFeedCache(buildFeedCacheKey("home:feed", {
      type: "LOST", category: "Electronics", status: "OPEN", sort: "oldest", q: "wallet",
    }), { items: [{ id: "cached", title: "Cached result" }] as never, total: 1, cursor: null, scrollTop: 0 });
    renderHome(entry);
    expect(await screen.findByText("cached")).toBeTruthy();
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("lets Android Back dismiss the Filters sheet without navigating away from Home", async () => {
    renderHome("/?q=wallet");
    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    act(() => expect(consumeBackIntercept()).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: /^filters/i }).getAttribute("aria-expanded")).toBe("false"));
    expect(screen.getByTestId("location").textContent).toBe("/?q=wallet");
  });

  it("clear button appears while typing and clears the query, URL param, and feed filter", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    // Compact at rest: no clear affordance, no cancel.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "wallet" } });
    await waitFor(
      () => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "wallet" }), undefined),
      { timeout: 3000 },
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("q=wallet"));

    // Active field: clear + cancel affordances present.
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fetchFeedMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("");
    // Clearing restores the cached unfiltered feed instead of refetching:
    // the URL param drops, the cached rows return, and no network call fires.
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("q="));
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("cancel collapses the active field back to its compact state", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "wallet" } });
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("re-tapping the active Home tab scrolls smoothly and refreshes", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      const { rerender } = renderHome();
      await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
      fetchFeedMock.mockClear();

      tabTapState.tapCount = 1;
      rerender(
        <MemoryRouter initialEntries={["/"]}>
          <Home />
          <LocationProbe />
        </MemoryRouter>,
      );

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("re-tapping the active Home tab scrolls instantly under reduced motion", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      const { rerender } = renderHome();
      await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

      tabTapState.tapCount = 1;
      rerender(
        <MemoryRouter initialEntries={["/"]}>
          <Home />
          <LocationProbe />
        </MemoryRouter>,
      );

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
    } finally {
      window.matchMedia = originalMatchMedia;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("restores the cached scroll position on return without refetching", async () => {
    saveFeedCache(buildFeedCacheKey("home:feed", { type: "", sort: "newest" }), {
      items: [{ id: "cached", title: "Cached result" }] as never,
      total: 1,
      cursor: null,
      scrollTop: 200,
    });
    const { container } = renderHome();
    expect(await screen.findByText("cached")).toBeTruthy();
    expect(fetchFeedMock).not.toHaveBeenCalled();

    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    await waitFor(() => expect((scroller as HTMLElement).scrollTop).toBe(200));
  });

  it("shows the new-posts pill when scrolled and removes it cleanly on tap", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      const { container } = renderHome();
      await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
      expect(screen.queryByText(/new post/i)).toBeNull();

      const scroller = container.querySelector(".overflow-y-auto");
      expect(scroller).toBeTruthy();
      (scroller as HTMLElement).scrollTop = 100;

      act(() =>
        emit("feed:changed", { change: "INSERT", op: "INSERT", postId: "n1", postType: "LOST", title: "Lost wallet" }),
      );
      expect(await screen.findByText("1 new post")).toBeTruthy();

      // A second insert updates the count label (no full re-render of rows).
      act(() =>
        emit("feed:changed", { change: "INSERT", op: "INSERT", postId: "n2", postType: "FOUND", title: "Found keys" }),
      );
      expect(await screen.findByText("2 new posts")).toBeTruthy();
      expect(screen.getByText("a")).toBeTruthy();

      fetchFeedMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /tap to refresh/i }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      await waitFor(() => expect(screen.queryByText(/new post/i)).toBeNull());
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("gives the toolbar separation once the feed scrolls", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const toolbar = screen.getByTestId("home-toolbar");
    expect(toolbar.className).not.toContain("shadow-sm");

    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    (scroller as HTMLElement).scrollTop = 100;
    fireEvent.scroll(scroller as HTMLElement);

    await waitFor(() => expect(screen.getByTestId("home-toolbar").className).toContain("shadow-sm"));
  });
});
