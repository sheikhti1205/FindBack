// @vitest-environment jsdom
// MINOR-D: the Home capture handler must ignore EVERY descendant scroller, not
// just the filter rail. `Home.test.tsx` mocks `PostList`, so no card — and
// therefore no photo carousel, the descendant that actually gets swiped most —
// ever exists in the suite. A guard written as "ignore `.fb-scroll-row`" passed
// all 146 tests while carousels still reset the chrome. This file mounts the
// real `PostList` so the real `FeedMediaCarousel` is in the tree under the real
// handler.
import type { PostItem } from "@norfold/shared";
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

describe("Home feed with the real card carousel", () => {
  it("leaves the feed alone when a card's photo carousel is swiped", async () => {
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

    // The real PostList rendered a card with the real carousel: a horizontal
    // scroller nested inside the feed's vertical one.
    await waitFor(() => expect(screen.getByTestId("feed-media-track")).toBeTruthy());
    const track = screen.getByTestId("feed-media-track");
    expect(track.className).toContain("overflow-x-auto");

    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    // The bar is feed content, so it lives in the same vertical scroller.
    expect(scroller.contains(screen.getByTestId("home-toolbar"))).toBe(true);
    expect(scroller.contains(track)).toBe(true);

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    // Swiping the carousel scrolls that track only: the feed's own offset and
    // the bar's place in it never change, because nothing observes scrolls and
    // nothing translates the row.
    const liveTrack = screen.getByTestId("feed-media-track");
    expect(liveTrack.isConnected).toBe(true);
    liveTrack.scrollLeft = 240;
    fireEvent.scroll(liveTrack);

    expect(scroller.scrollTop).toBe(100);
    expect(scroller.contains(screen.getByTestId("home-toolbar"))).toBe(true);
    expect(screen.getByTestId("home-toolbar").hasAttribute("inert")).toBe(false);

    // The wordmark is never shrunk now: the whole row leaves with the feed.
    const wordmark = container.querySelector('[data-testid="home-brand-wordmark"]');
    expect(wordmark!.getAttribute("data-compact")).toBeNull();
  });
});
