// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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
  PostList: ({ items, error, emptySubtitle, onRetry, masonryColumns }: { items: Array<{ id: string }>; error: string | null; emptySubtitle: string; onRetry: () => Promise<void>; masonryColumns?: number }) => (
    <div>
      <span data-testid="post-columns">{masonryColumns}</span>
      {error ? <><p role="alert">{error}</p><button onClick={() => void onRetry()}>Try again</button></> : null}
      {!error && items.length === 0 ? <p>{emptySubtitle}</p> : null}
      <ul data-testid="posts">{items.map((i) => <li key={i.id}>{i.id}</li>)}</ul>
    </div>
  ),
}));

import { Home } from "./Home";
import { buildFeedCacheKey, clearFeedCaches, saveFeedCache } from "../hooks/feedCache";
import { consumeBackIntercept, resetBackInterceptors } from "../components/backNavigation";
import { ringOutcome } from "../test-utils/focusRingCascade";

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

/**
 * The search field is not resident (owner redesign, 2026-10-19): it mounts only
 * after the trailing search affordance is activated. Every test that types has
 * to activate it first — that IS the behaviour under test, so it is not hidden
 * inside a fake.
 */
function openSearch() {
  fireEvent.click(screen.getByTestId("home-search-open"));
  return screen.getByLabelText("Search posts") as HTMLInputElement;
}

/**
 * jsdom has no layout: framer's `PopChild` measures `0x0` and skips the pop, so
 * the real `popLayout` path never runs. Supply the trigger's measured box (and
 * a `getComputedStyle` scoped to that one element) and return the restore. The
 * numbers are deliberately NOT the trigger's class size, so an assertion about
 * "48px" cannot be satisfied by a constant.
 */
function stubTriggerBox(
  trigger: HTMLElement,
  row: HTMLElement,
  measured: { width: number; height: number; left: number; top: number; parentWidth: number },
): () => void {
  Object.defineProperty(trigger, "offsetLeft", { configurable: true, value: measured.left });
  Object.defineProperty(trigger, "offsetTop", { configurable: true, value: measured.top });
  Object.defineProperty(trigger, "offsetParent", { configurable: true, value: row });
  Object.defineProperty(row, "offsetWidth", { configurable: true, value: measured.parentWidth });

  const origGetComputedStyle = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((el, pseudo) => {
    const styles = origGetComputedStyle(el, pseudo);
    if (el !== trigger) return styles;
    return new Proxy(styles, {
      get: (target, prop, receiver) => {
        if (prop === "width") return `${measured.width}px`;
        if (prop === "height") return `${measured.height}px`;
        if (prop === "direction") return "ltr";
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle);
  return () => spy.mockRestore();
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

    fireEvent.change(openSearch(), { target: { value: "wallet" } });
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

    expect(await screen.findByRole("button", { name: "Updates — tap to refresh" })).toBeTruthy();
    expect(screen.queryByText(/new post/i)).toBeNull();
  });

  it("collapses the brand wordmark on scroll and restores it at the top", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const wordmark = () =>
      container.querySelector('[data-testid="home-brand-wordmark"]') as HTMLElement;
    const chrome = () => container.querySelector('[data-testid="home-chrome"]') as HTMLElement;

    expect(wordmark().getAttribute("data-compact")).toBe("false");

    // Deliberate downward travel, not yet enough to take the bar: the word goes
    // first, the bar follows (owner ruling 2026-10-19).
    scroller.scrollTop = 30;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(wordmark().getAttribute("data-compact")).toBe("true"));

    // The bar itself is still on screen — this stage is not the chrome collapse,
    // and the wordmark keeps its box so nothing in the row reflows.
    expect(chrome().getAttribute("data-collapsed")).toBe("false");
    expect(wordmark().textContent).toBe("FindBack");
    // The control keeps its name and its mark: only the word's ink is gone.
    expect(screen.getByRole("button", { name: /scroll the feed to the top/i })).toBeTruthy();

    // Far enough down and the whole chrome still leaves, as it always did.
    // (Small steps: one 370px delta would be a programmatic jump, which the
    // tracker deliberately ignores.)
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(chrome().getAttribute("data-collapsed")).toBe("true"));

    // A controlled pull back mid-feed restores both — not only a return to the
    // top. Independent review BLOCKER-1: the wordmark restore used to be
    // unreachable for every uniform drag step, and the old assertions could not
    // see it (they restored via the top zone). This loop is the regression guard.
    for (let top = 92; top > 24; top -= 8) {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    }
    await waitFor(() => expect(chrome().getAttribute("data-collapsed")).toBe("false"));
    expect(scroller.scrollTop).toBeGreaterThan(24); // mid-feed, not the top zone
    await waitFor(() => expect(wordmark().getAttribute("data-compact")).toBe("false"));

    // Back at the top the name returns.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(wordmark().getAttribute("data-compact")).toBe("false"));
  });

  it("ignores scroll events from a descendant scroller", async () => {
    // The screen root observes scrolls in the capture phase, so it sees every
    // scroller inside Home — the filter rail and each card's photo carousel
    // included. A horizontal swipe leaves that target's `scrollTop` at 0, which
    // the collapse machine used to read as "back at the top": the chrome and the
    // wordmark popped back in, and the next 3px of downward travel then counted
    // as a fresh 103px jump against a rebased `lastY`. Only the feed's own
    // scroller may decide the chrome.
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const rail = container.querySelector(".fb-scroll-row") as HTMLElement;
    const wordmark = () =>
      container.querySelector('[data-testid="home-brand-wordmark"]') as HTMLElement;
    const chrome = () => container.querySelector('[data-testid="home-chrome"]') as HTMLElement;
    const toolbar = () => screen.getByTestId("home-toolbar");

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(chrome().getAttribute("data-collapsed")).toBe("true"));
    expect(wordmark().getAttribute("data-compact")).toBe("true");
    expect(toolbar().className).toContain("border-outline-variant");

    // A real horizontal scroll: the rail overflows at 320dp and its vertical
    // offset is always 0.
    rail.scrollTop = 0;
    fireEvent.scroll(rail);

    expect(chrome().getAttribute("data-collapsed")).toBe("true");
    expect(wordmark().getAttribute("data-compact")).toBe("true");
    expect(toolbar().className).toContain("border-outline-variant");

    // The tracker kept the feed's `lastY`: 3px of further travel is 3px, not a
    // 103px rebase, so neither stage moves.
    scroller.scrollTop = 103;
    fireEvent.scroll(scroller);
    expect(chrome().getAttribute("data-collapsed")).toBe("true");
    expect(wordmark().getAttribute("data-compact")).toBe("true");
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

    fireEvent.change(openSearch(), { target: { value: "wallet" } });
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

    // Compact at rest: no field, no clear, no close — the row is title + actions.
    expect(screen.queryByLabelText("Search posts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close search" })).toBeNull();
    expect(screen.getByTestId("home-search-open").getAttribute("aria-label")).toBe("Open search");

    fireEvent.change(openSearch(), { target: { value: "wallet" } });
    await waitFor(
      () => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "wallet" }), undefined),
      { timeout: 3000 },
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("q=wallet"));

    // Active field: clear + close affordances present.
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close search" })).toBeTruthy();
    // ...and the trigger is gone, so there is never a second search control.
    expect(screen.queryByTestId("home-search-open")).toBeNull();

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

  it("closing the field collapses it back to the compact row and drops the query", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.change(openSearch(), { target: { value: "wallet" } });
    expect(await screen.findByRole("button", { name: "Close search" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    await waitFor(() => expect(screen.queryByLabelText("Search posts")).toBeNull());
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    // Reopening starts empty: closing cleared the query rather than hiding it.
    expect(openSearch().value).toBe("");
  });

  it("re-tapping the active Home tab at the top refreshes and scrolls smoothly", async () => {
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

  it("re-tapping the active Home tab at the top scrolls instantly under reduced motion", async () => {
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

  it("saves the reader's place on the way to Post Detail and restores it on return", async () => {
    // The save half of the pair above. React detaches the scroll ref before the
    // hook's unmount cleanup runs, so this failed in the product (the cache got
    // scrollTop 0) while the seeded test above stayed green.
    const first = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const scroller = first.container.querySelector(".fb-home-feed") as HTMLElement;
    scroller.scrollTop = 240;
    // jsdom does not fire a scroll event on assignment; the real container does.
    fireEvent.scroll(scroller);
    first.unmount();

    fetchFeedMock.mockClear();
    const second = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const restored = second.container.querySelector(".fb-home-feed") as HTMLElement;
    await waitFor(() => expect(restored.scrollTop).toBe(240));
    expect(fetchFeedMock).not.toHaveBeenCalled();
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
      expect(await screen.findByRole("button", { name: "1 new post — tap to refresh" })).toBeTruthy();

      // A second insert updates the count label (no full re-render of rows).
      act(() =>
        emit("feed:changed", { change: "INSERT", op: "INSERT", postId: "n2", postType: "FOUND", title: "Found keys" }),
      );
      expect(await screen.findByRole("button", { name: "2 new posts — tap to refresh" })).toBeTruthy();
      expect(screen.getByText("a")).toBeTruthy();

      fetchFeedMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /tap to refresh/i }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      await waitFor(() => expect(screen.queryByRole("button", { name: /new posts? — tap to refresh/i })).toBeNull());
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

describe("Home scroll-reactive chrome (CF-010)", () => {
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

  function renderAndWait() {
    const rendered = renderHome();
    return waitFor(() => expect(screen.getByText("b")).toBeTruthy()).then(() => rendered);
  }

  it("collapses on a deliberate downward scroll and restores it on one upward move", async () => {
    const { container } = await renderAndWait();
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller).toBeTruthy();
    const collapsed = () => screen.getByTestId("home-chrome").getAttribute("data-collapsed");

    expect(collapsed()).toBe("false");

    // A short move inside the top zone leaves the chrome alone.
    scroller.scrollTop = 12;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(collapsed()).toBe("false"));

    // A real move that has not banked enough travel yet: still visible.
    scroller.scrollTop = 30;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(collapsed()).toBe("false"));

    // Enough deliberate downward travel past the zone: collapsed.
    scroller.scrollTop = 75;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(collapsed()).toBe("true"));

    // Hysteresis: a short upward nudge below the reveal travel is not enough.
    scroller.scrollTop = 70;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(collapsed()).toBe("true"));

    // One real upward move brings it back — with less travel than hiding took.
    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(collapsed()).toBe("false"));
  });

  it("marks the collapsed chrome inert so an off-screen control cannot take focus", async () => {
    const { container } = await renderAndWait();
    const chrome = screen.getByTestId("home-chrome");
    expect(chrome.hasAttribute("inert")).toBe(false);

    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    scroller.scrollTop = 140;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(chrome.hasAttribute("inert")).toBe(true));

    // The reader gets it back the moment they scroll up.
    scroller.scrollTop = 118;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(chrome.hasAttribute("inert")).toBe(false));
  });

  it("keeps the chrome open while the search field is active, whatever the scroll", async () => {
    const { container } = await renderAndWait();
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    scroller.scrollTop = 140;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(screen.getByTestId("home-chrome").getAttribute("data-collapsed")).toBe("true"),
    );

    // Activating the search affordance pins the chrome open for the whole session.
    const field = openSearch();
    fireEvent.focus(field);
    await waitFor(() =>
      expect(screen.getByTestId("home-chrome").getAttribute("data-collapsed")).toBe("false"),
    );

    scroller.scrollTop = 400;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("home-chrome").getAttribute("data-collapsed")).toBe("false");

    // Blurring hands control back to the scroll direction.
    fireEvent.blur(field);
    scroller.scrollTop = 460;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(screen.getByTestId("home-chrome").getAttribute("data-collapsed")).toBe("true"),
    );
  });

  it("scrolls to the top from the brand without spending a request", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      await renderAndWait();
      expect(fetchFeedMock).toHaveBeenCalledTimes(1);

      const brand = screen.getByTestId("home-brand");
      // The visible label is in the accessible name (WCAG 2.5.3) and the action
      // is announced, since the mark itself is not a control label.
      expect(brand.getAttribute("aria-label")).toContain("FindBack");
      fireEvent.click(brand);

      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
      expect(fetchFeedMock).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("scrolls the brand to the top instantly under reduced motion", async () => {
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
      await renderAndWait();
      fireEvent.click(screen.getByTestId("home-brand"));
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    } finally {
      window.matchMedia = originalMatchMedia;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("returns a scrolled reader to the top on a tab tap without a network refresh", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      const { container, rerender } = await renderAndWait();
      const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
      scroller.scrollTop = 400;
      fetchFeedMock.mockClear();

      tabTapState.tapCount = 1;
      rerender(
        <MemoryRouter initialEntries={["/"]}>
          <Home />
          <LocationProbe />
        </MemoryRouter>,
      );

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" }));
      // Getting back to the top is not a refresh request.
      expect(fetchFeedMock).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  // `tapCount` lives above the route outlet and never resets, so the effect that
  // serves a tap must consume it once. These two tests are the ones the suite
  // was missing: they mount with a tap already recorded, which is what a
  // remount sees, and they change the feed scope, which is what a chip tap
  // does.
  it("does not replay the last tab tap when Home remounts (Post Detail → Back)", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      // The reader tapped the active Home tab once, and that mount served it.
      tabTapState.tapCount = 1;
      const first = await renderAndWait();
      first.unmount();
      scrollTo.mockClear();
      fetchFeedMock.mockClear();

      await renderAndWait();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A round trip to a post keeps the restored scroll position and its cached
      // feed: no jump to the top and no refetch.
      expect(scrollTo).not.toHaveBeenCalled();
      expect(fetchFeedMock).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("does not rewind the reader when the feed scope changes after a tap", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    try {
      const { rerender } = await renderAndWait();

      tabTapState.tapCount = 1;
      rerender(
        <MemoryRouter initialEntries={["/"]}>
          <Home />
          <LocationProbe />
        </MemoryRouter>,
      );
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
      scrollTo.mockClear();
      fetchFeedMock.mockClear();

      fireEvent.click(screen.getByRole("radio", { name: "Lost" }));

      // The scope change refetches exactly once, from its own effect — and must
      // not be mistaken for a tab tap, which both rewound the feed under the
      // reader and added a second `fetchFeed` on top of the scope's own one
      // (the reviewer's probe measured two `fetchFeed({type:"LOST"})` calls).
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });
});

describe("Home feed redesign (reference-inspired)", () => {
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

  it("offers All/Lost/Found quick chips and no dead Nearby/Recent chip", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    expect(screen.getByRole("radio", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Lost" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Found" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Nearby" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Recent" })).toBeNull();
  });

  it("keeps one compact row: brand and wordmark, with the actions trailing", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    // The owner's requirement: an idle Home has no resident search field and no
    // second line of chrome, so the feed keeps the space.
    expect(screen.queryByLabelText("Search posts")).toBeNull();
    expect(screen.getByTestId("home-toolbar").textContent).not.toMatch(/signed in as/);
    expect(screen.getByTestId("home-brand").textContent).toContain("FindBack");

    // The actions trail the title unit, and the field reuses the same copy.
    expect(screen.getByRole("button", { name: /^filters/i })).toBeTruthy();
    expect(openSearch().placeholder).toBe("Search posts…");
  });

  it("moves focus into the field on an intentional activation", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.click(screen.getByTestId("home-search-open"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search posts")));
  });

  it.each(["Close search", "Filters"])("keeps empty search open when focus moves to %s", async (label) => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const input = openSearch();
    await waitFor(() => expect(document.activeElement).toBe(input));
    await waitFor(() => expect(screen.queryByTestId("home-brand")).toBeNull());
    const control = screen.getByRole("button", { name: label });
    act(() => control.focus());
    // Losing input focus must not replace the row while its next control is
    // receiving keyboard focus or a pointer-down. Browser proof additionally
    // clicks Filters inside the150ms exit and checks the real hit target.
    expect(screen.queryByTestId("home-brand")).toBeNull();
    expect(document.activeElement).toBe(control);
    if (label === "Filters") {
      fireEvent.click(control);
      expect(await screen.findByRole("dialog", { name: "Filters" })).toBeTruthy();
    } else {
      fireEvent.click(control);
      expect(await screen.findByTestId("home-brand")).toBeTruthy();
    }
  });

  it("closes empty search once focus leaves the app bar", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    const input = openSearch();
    await waitFor(() => expect(document.activeElement).toBe(input));
    await waitFor(() => expect(screen.queryByTestId("home-brand")).toBeNull());
    act(() => input.blur());
    expect(await screen.findByTestId("home-brand")).toBeTruthy();
  });

  it("keeps the open state the same height as the title row", async () => {
    // Regression: the pill's border used to be added on top of a 48px child, so
    // opening search grew the row 48 -> 50 and pushed the chips and the feed.
    // jsdom cannot measure, so this pins the contract the geometry depends on:
    // the pill owns the 48px minimum and every child stays under its 46px inner
    // box. The rendered numbers are in the harness `matrix.json`.
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(screen.getByTestId("home-search-open"));

    const pill = await screen.findByTestId("home-search-field");
    expect(pill.className).toContain("min-h-[48px]");
    for (const child of Array.from(pill.querySelectorAll("[class]"))) {
      expect(child.className).not.toContain("min-h-[48px]");
    }
  });

  it("freezes the exiting trigger at its measured box so the field keeps its settled width", async () => {
    // The trigger and the field share one flex slot. While the trigger exits it
    // must not keep reserving its width, or the entering pill spends the whole
    // 150ms crossfade narrower than it settles and widens in one frame at the
    // end. jsdom has no layout, so the trigger's measured box is supplied
    // explicitly — deliberately NOT the 48px its class suggests — and the
    // assertion reads that measurement back out of the rule framer injects. A
    // stub that answers "48px" for every element only proved that some rule
    // existed, not that the trigger's own geometry was captured.
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    const row = screen.getByTestId("home-search-row");
    const trigger = screen.getByTestId("home-search-open");
    const measured = { width: 46, height: 44, left: 251, top: 3, parentWidth: 320 };
    const restoreBox = stubTriggerBox(trigger, row, measured);
    try {
      fireEvent.click(trigger);
      await waitFor(() => expect(trigger.hasAttribute("data-motion-pop-id")).toBe(true));
      const id = trigger.getAttribute("data-motion-pop-id");
      // framer injects the rule through CSSOM (`insertRule`), so the style
      // element's text stays empty — read the sheet, not textContent.
      const rule = Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules))
        .map((cssRule) => cssRule.cssText)
        .find((text) => text.includes(`[data-motion-pop-id="${id}"]`));
      // Absolute and frozen at the box it actually had (anchorX/anchorY default
      // to left/top): the flex row stops reserving it, so the field is already
      // at its settled width during the crossfade.
      expect(rule).toContain("position: absolute !important");
      expect(rule).toContain(`width: ${measured.width}px !important`);
      expect(rule).toContain(`height: ${measured.height}px !important`);
      expect(rule).toContain(`left: ${measured.left}px !important`);
      expect(rule).toContain(`top: ${measured.top}px !important`);
      expect(screen.getByTestId("home-search-field").className).toContain("flex-1");
    } finally {
      restoreBox();
    }
  });

  it("hands the exiting trigger's slot to the filter button for the whole swap", async () => {
    // MINOR-A: `popLayout` takes the exiting trigger out of flow so the field
    // owns the slot from its first frame, and the right-aligned filter button
    // then slides into exactly the 48px box the popped trigger was measured at.
    // The ghost is later in DOM order, so before this fix it painted over the
    // filter icon and swallowed a tap aimed at it for the whole 150ms exit.
    //
    // jsdom has neither layout nor hit testing, so the row's measured geometry
    // is supplied (320px row, ONE 48px action slot pinned to its right edge —
    // the box the popped trigger was measured at) and a tap is resolved against
    // it the way a browser does: the topmost node under the point that still
    // accepts pointer events wins. The real stylesheet is loaded, so which node
    // accepts the tap comes from index.css and not from the test.
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync("src/index.css", "utf8");
    document.head.appendChild(sheet);
    let restoreBox: (() => void) | null = null;
    try {
      renderHome();
      await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

      const ROW = 320;
      const SLOT = 48;
      const box = (left: number, width: number) =>
        ({
          x: left,
          y: 0,
          left,
          right: left + width,
          top: 0,
          bottom: 48,
          width,
          height: 48,
          toJSON: () => ({}),
        }) as DOMRect;

      const row = screen.getByTestId("home-search-row");
      const filter = screen.getByRole("button", { name: /^filters/i });
      const trigger = screen.getByTestId("home-search-open");
      row.getBoundingClientRect = () => box(0, ROW);
      filter.getBoundingClientRect = () => box(ROW - SLOT, SLOT);
      // The ghost keeps the box it was measured at, not where it "would be".
      trigger.getBoundingClientRect = () => box(ROW - SLOT, SLOT);
      // PopChild skips the pop on jsdom's 0x0 measurement; the collision this
      // test is about only exists once the trigger is really popped.
      restoreBox = stubTriggerBox(trigger, row, {
        width: SLOT,
        height: SLOT,
        left: ROW - SLOT,
        top: 0,
        parentWidth: ROW,
      });

      function hitAt(x: number, y: number): Element | null {
        const under = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        });
        for (let i = under.length - 1; i >= 0; i -= 1) {
          const candidate = under[i];
          if (!candidate) continue;
          const styles = getComputedStyle(candidate);
          if (styles.pointerEvents === "none" || styles.visibility === "hidden") continue;
          return candidate;
        }
        return null;
      }
      const tapCentre = { x: ROW - SLOT / 2, y: 24 };
      const filterReceives = () => {
        const hit = hitAt(tapCentre.x, tapCentre.y);
        return hit === filter || filter.contains(hit);
      };

      fireEvent.click(trigger);
      screen.getByTestId("home-search-field").getBoundingClientRect = () => box(0, ROW - SLOT);
      await waitFor(() => expect(trigger.hasAttribute("data-motion-pop-id")).toBe(true));

      let samples = 0;
      const deadline = Date.now() + 145; // the exit is 150ms (motionDurations.fast)
      while (Date.now() < deadline) {
        const ghost = screen.queryByTestId("home-search-open");
        if (!ghost) break;
        expect(
          getComputedStyle(ghost).visibility,
          "the popped ghost must be out of hit testing in the slot it vacated",
        ).toBe("hidden");
        expect(filterReceives()).toBe(true);
        samples += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Several samples, so this measured a transition and not a settled state.
      expect(samples).toBeGreaterThanOrEqual(3);

      // And once the ghost is gone the slot stays the filter's.
      await waitFor(() => expect(screen.queryByTestId("home-search-open")).toBeNull());
      expect(filterReceives()).toBe(true);
    } finally {
      sheet.remove();
      restoreBox?.();
    }
  });


  it("draws the field's focus ring on the pill, not inside it", async () => {
    // `index.css` `.fb-home-search-field` owns the ring because the app-wide
    // `:focus-visible` rule is unlayered and a utility cannot suppress it. The
    // input must therefore not pretend to opt out with a utility that loses.
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(screen.getByTestId("home-search-open"));

    const pill = await screen.findByTestId("home-search-field");
    expect(pill.className).toContain("fb-home-search-field");
    expect(screen.getByLabelText("Search posts").className).not.toContain("focus:outline-none");
  });

  it("keeps a top-level heading while the field replaces the wordmark", async () => {
    // The field branch replaces the brand branch, so without a heading of its
    // own the Home screen would lose heading navigation while searching. The
    // crossfade keeps the outgoing branch mounted briefly, so this asserts the
    // settled state rather than the overlap.
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("FindBack");
    // NIT: the heading wraps the brand button, whose label is an instruction.
    // The page's H1 must announce the page's name, not the control's hint.
    expect(screen.getByRole("heading", { level: 1, name: "FindBack" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("home-search-open"));
    await waitFor(() => expect(screen.getByLabelText("Search posts")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("FindBack");
  });

  it("restores a query from the URL without raising the keyboard", async () => {
    // The field is present because it holds a value — but nothing is focused, so
    // a shared link never opens the keyboard on the reader.
    renderHome("/?q=wallet");
    const restored = screen.getByLabelText("Search posts") as HTMLInputElement;
    expect(restored.value).toBe("wallet");
    expect(document.activeElement).not.toBe(restored);
  });

  it("returns focus to the search affordance when the field closes", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.change(openSearch(), { target: { value: "wallet" } });
    fireEvent.click(await screen.findByRole("button", { name: "Close search" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("home-search-open")));
  });

  it("lets Android Back close a focused field instead of leaving Home", async () => {
    renderHome("/?q=wallet");
    fireEvent.focus(screen.getByLabelText("Search posts"));

    act(() => expect(consumeBackIntercept()).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("Search posts")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("q="));
  });

  it("keeps Back as navigation while the query is only a browsing filter", async () => {
    // A typed-but-unfocused query is how the reader browses results; Back must
    // still navigate rather than silently discard the filter.
    renderHome("/?q=wallet");
    expect(screen.getByLabelText("Search posts")).toBeTruthy();
    expect(consumeBackIntercept()).toBe(false);
  });

  it("keeps Back as navigation when focus moves from the field to Filters", async () => {
    // Close, Clear and Filters live inside the search row, so the row keeps
    // focus when the field loses it. Back must disarm on the *field's* focus,
    // not the row's, or one Back press silently discards a typed query
    // (review HOME-SCROLL-FIXFORWARD-R2 MINOR-1).
    renderHome("/?q=wallet");
    const input = screen.getByLabelText("Search posts");
    fireEvent.focus(input);
    fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "Filters" }) });

    expect(consumeBackIntercept()).toBe(false);
    expect(screen.getByLabelText("Search posts")).toBeTruthy();
  });

  it("returns focus to the field after Clear so the next Tab is not skipped", async () => {
    // Clearing is done in order to retype. The Clear button unmounts with the
    // query, so without an explicit hand-back focus lands on <body>
    // (review HOME-SCROLL-FIXFORWARD-R2 MINOR-2).
    renderHome("/?q=wallet");
    const input = screen.getByLabelText("Search posts");
    fireEvent.focus(input);
    const clear = await screen.findByRole("button", { name: "Clear search" });
    // A pointer press takes focus off the field before the click lands.
    act(() => input.blur());
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(clear);

    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("value")).toBe("");
  });
});

describe("Home app-bar focus ring (index.css cascade)", () => {
  const css = readFileSync("src/index.css", "utf8");
  const HAS = { hasSelector: true } as const;
  const LEGACY = { hasSelector: false } as const;

  // These read the real declarations, in real specificity order, for a given
  // engine generation — not the selector text. The previous version matched
  // block headers, so a higher-specificity `outline: 0` override passed, and it
  // asserted that the `:focus-within` fallback must not exist at all, which is
  // the one rule that keeps a ring on a WebView without `:has()` (Chromium
  // < 105; `minSdk 24` does not bound the WebView).

  it("keeps a ring on the pill where :has() is unsupported", () => {
    const legacyInput = ringOutcome(css, LEGACY, "input");
    // Without the fallback this is `null` — the field painted nothing at all,
    // because the input's own ring is suppressed in every engine.
    expect(legacyInput.pill).toBe("2px solid var(--fb-focus)");
    expect(legacyInput.pillOffset).toBe("2px");
    expect(legacyInput.input).toBe("none");
  });

  it("paints exactly one ring per control where :has() exists", () => {
    const modernInput = ringOutcome(css, HAS, "input");
    expect(modernInput.pill).toBe("2px solid var(--fb-focus)");
    expect(modernInput.input).toBe("none");

    // Tab to Close/Clear: the button keeps the app-wide ring and the pill must
    // not add a second contour.
    const modernButton = ringOutcome(css, HAS, "button");
    expect(modernButton.pill).toBe("none");
    expect(modernButton.button).toBe("2px solid var(--fb-focus)");

    // Nothing focused, nothing painted.
    expect(ringOutcome(css, HAS, "none").pill).toBeNull();
  });

  it("accepts the legacy double contour, but never a missing ring", () => {
    // Documented trade-off of the fallback: a `:focus-within` pill ring cannot
    // tell which descendant was focused, so on those engines a button focus
    // shows the pill contour too. Two contours are a cosmetic regression on an
    // old engine; zero contours is the accessibility defect this pins.
    const legacyButton = ringOutcome(css, LEGACY, "button");
    expect(legacyButton.pill).toBe("2px solid var(--fb-focus)");
    expect(legacyButton.button).toBe("2px solid var(--fb-focus)");
  });

  it("is not defeated by a higher-specificity override", () => {
    // Self-check of the evaluator against the exact counterexample from the
    // review: `html .fb-home-search-field:has(...) { outline: 0 }` beat the
    // old text-matching test while painting nothing. If a rule like this lands
    // in index.css, the two tests above fail.
    const defeated = ringOutcome(
      `${css}\nhtml .fb-home-search-field:has(input:focus-visible) { outline: 0; }`,
      HAS,
      "input",
    );
    expect(defeated.pill).toBe("0");
  });
});

describe("Home masonry width (adaptive navigation)", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    onRealtimeMock.mockClear();
    handlers.clear();
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({
      items: ["a", "b", "c"].map((id) => ({ id, title: id })),
      nextCursor: null,
      total: 3,
    });
  });

  it("counts columns from the feed's own width, not the viewport", async () => {
    const previous = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    try {
      renderHome();
      await waitFor(() => expect(screen.getByTestId("posts")).toBeTruthy());
      const canvas = screen.getByTestId("home-feed-canvas");
      // Unmeasured (jsdom): the viewport fallback, i.e. 600 -> two columns.
      expect(screen.getByTestId("post-columns").textContent).toBe("2");

      // The side rail takes 104px out of this row: the feed reports 496.
      Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 496 });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      await waitFor(() => expect(screen.getByTestId("post-columns").textContent).toBe("1"));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previous });
    }
  });
});
