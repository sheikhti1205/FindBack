// @vitest-environment jsdom
// MINOR-D: the Home capture handler must ignore EVERY descendant scroller, not
// just the filter rail. `Home.test.tsx` mocks `PostList`, so no card — and
// therefore no photo carousel, the descendant that actually gets swiped most —
// ever exists in the suite. A guard written as "ignore `.fb-scroll-row`" passed
// all 146 tests while carousels still reset the chrome. This file mounts the
// real `PostList` so the real `FeedMediaCarousel` is in the tree under the real
// handler.
import type { PostItem } from "@findback/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFeedCaches } from "../hooks/feedCache";

const { fetchFeedMock, onRealtimeMock, tabTapState } = vi.hoisted(() => ({
  fetchFeedMock: vi.fn(),
  tabTapState: { tapCount: 0 },
  onRealtimeMock: vi.fn(() => () => undefined),
}));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../services/realtime", () => ({ onRealtime: onRealtimeMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));
// The feed's reaction summary is a network read; the carousel does not need it.
vi.mock("../services/feedReactions", () => ({
  fetchFeedReactionState: vi.fn().mockResolvedValue(new Map()),
  toggleLikeReaction: vi.fn(),
}));

import { Home } from "./Home";

function imageAttachment(index: number) {
  return {
    id: `a${index}`,
    fileUrl: `https://cdn.example/a${index}.jpg`,
    mimeType: "image/jpeg",
    fileName: `a${index}.jpg`,
    fileSize: 10,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function photoPost(): PostItem {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Golden Retriever near Riverside Park",
    description: "Our dog Max went missing this morning near the park entrance.",
    category: "Pets",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: "Riverside Park",
    youtubeUrl: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    likeCount: 2,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 1,
    attachments: [imageAttachment(1), imageAttachment(2)],
  } as unknown as PostItem;
}

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  fetchFeedMock.mockReset();
  onRealtimeMock.mockClear();
  tabTapState.tapCount = 0;
  clearFeedCaches();
  fetchFeedMock.mockResolvedValue({ items: [photoPost()], nextCursor: null, total: 1 });
});

afterEach(() => {
  cleanup();
  clearFeedCaches();
});

describe("Home feed scroll capture with the real feed", () => {
  it("keeps the chrome collapsed when a card's photo carousel is swiped", async () => {
    // Home resolves its default `auto` layout from the viewport width: at
    // jsdom's 1024 it would pick the masonry grid, whose cards render media
    // through a different component. A phone width selects the real Home
    // `home-feed` card, which owns the carousel.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Home />
      </MemoryRouter>,
    );

    // The real PostList rendered a card with the real carousel: this is the
    // descendant that the mocked suite could never produce.
    await waitFor(() => expect(screen.getByTestId("feed-media-track")).toBeTruthy());
    const track = screen.getByTestId("feed-media-track");
    expect(track.className).toContain("overflow-x-auto");

    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const chrome = () => container.querySelector('[data-testid="home-chrome"]') as HTMLElement;
    const wordmark = () =>
      container.querySelector('[data-testid="home-brand-wordmark"]') as HTMLElement;
    const toolbar = () => screen.getByTestId("home-toolbar");

    // Collapse both stages on the feed's own scroller.
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(chrome().getAttribute("data-collapsed")).toBe("true"));
    expect(wordmark().getAttribute("data-compact")).toBe("true");
    expect(toolbar().className).toContain("border-outline-variant");

    // A horizontal carousel swipe: the track's vertical offset is always 0, so
    // a guard that reads any descendant's `scrollTop` reads "back at the top".
    //
    // The list re-renders on the chrome state change (and the collapsed frame
    // replaces the card subtree), so hold the LIVE carousel — querying once at
    // the top and firing at that handle afterwards dispatches the event into a
    // detached node, which the capture handler never sees. That vacuous pass is
    // exactly the failure mode MINOR-D is about, so the node is re-resolved and
    // proven connected before the swipe.
    const liveTrack = screen.getByTestId("feed-media-track");
    expect(liveTrack.isConnected).toBe(true);
    expect(scroller.contains(liveTrack)).toBe(true);
    liveTrack.scrollLeft = 240;
    fireEvent.scroll(liveTrack);

    expect(chrome().getAttribute("data-collapsed")).toBe("true");
    expect(wordmark().getAttribute("data-compact")).toBe("true");
    expect(toolbar().className).toContain("border-outline-variant");

    // And the feed's own tracker never left the feed: 3 more pixels of travel
    // are 3px, not a rebased jump.
    scroller.scrollTop = 103;
    fireEvent.scroll(scroller);
    expect(chrome().getAttribute("data-collapsed")).toBe("true");
    expect(wordmark().getAttribute("data-compact")).toBe("true");
  });
});
