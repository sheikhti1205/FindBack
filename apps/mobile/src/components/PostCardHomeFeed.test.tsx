// @vitest-environment jsdom
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostCard } from "./PostCard";
import { PostCardContent } from "./PostCardContent";
import { FeedLoveProvider, type FeedPatchItem } from "../hooks/useFeedLove";

const { feedFetchMock, loveToggleMock } = vi.hoisted(() => ({
  feedFetchMock: vi.fn(),
  loveToggleMock: vi.fn(),
}));

vi.mock("../services/feedReactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/feedReactions")>();
  return {
    ...actual,
    fetchFeedReactionState: feedFetchMock,
    toggleLikeReaction: loveToggleMock,
  };
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function post(overrides: Partial<PostItem> = {}): PostItem {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Golden Retriever near Riverside Park",
    description: "Our beloved dog Max went missing this morning near the park entrance.",
    category: "Pets",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: "Riverside Park, Austin, TX",
    youtubeUrl: null,
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    likeCount: 24,
    dislikeCount: 1,
    ratingAvg: 4.5,
    ratingCount: 2,
    commentCount: 3,
    attachments: [],
    ...overrides,
  } as PostItem;
}

function imageAttachments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i + 1}`,
    fileUrl: `https://cdn.example/a${i + 1}.jpg`,
    mimeType: "image/jpeg",
    fileName: `a${i + 1}.jpg`,
    fileSize: 10,
    createdAt: "2026-09-29T00:00:00.000Z",
  }));
}

function imagePost(count = 1, overrides: Partial<PostItem> = {}) {
  return post({ attachments: imageAttachments(count), ...overrides } as Partial<PostItem>);
}

/** Home-feed content always renders inside the feed love provider (as Home does). */
function renderHomeFeed(
  target: PostItem,
  opts: {
    items?: PostItem[];
    patchItem?: (id: string, patch: Partial<PostItem>) => void;
    reactions?: Record<string, { myReaction: "LIKE" | "DISLIKE" | null; myRating: number | null }>;
  } = {},
) {
  feedFetchMock.mockResolvedValue(opts.reactions ?? {});
  const patchItem = (opts.patchItem ?? vi.fn()) as ReturnType<typeof vi.fn>;
  const view = render(
    <MemoryRouter>
      <FeedLoveProvider
        items={opts.items ?? [target]}
        patchItem={patchItem as unknown as FeedPatchItem}
      >
        <PostCardContent post={target} layout="home-feed" />
      </FeedLoveProvider>
    </MemoryRouter>,
  );
  return { ...view, patchItem };
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findback.test");
  feedFetchMock.mockReset();
  loveToggleMock.mockReset();
  feedFetchMock.mockResolvedValue({});
  loveToggleMock.mockResolvedValue({
    postId: "p1",
    likeCount: 25,
    dislikeCount: 1,
    myReaction: "LIKE",
  });
});

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("PostCardContent home-feed (content-first Home layout)", () => {
  it("shows a Lost status chip with icon + text and keeps time as a separate element", () => {
    renderHomeFeed(imagePost());
    const chip = screen.getByTestId("post-status-chip");
    expect(chip.textContent).toMatch(/lost/i);
    // Icon + text redundancy: meaning must not be color-only.
    expect(chip.querySelector("svg")).toBeTruthy();
    const time = screen.getByTestId("post-time");
    expect(time.textContent).toMatch(/2h ago/);
    expect(time.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_CONTAINS).toBe(0);
    expect(chip.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_CONTAINS).toBe(0);
  });

  it("shows a Found status chip with icon + text", () => {
    renderHomeFeed(imagePost(1, { type: "FOUND" as PostType }));
    const chip = screen.getByTestId("post-status-chip");
    expect(chip.textContent).toMatch(/found/i);
    expect(chip.querySelector("svg")).toBeTruthy();
  });

  it("uses a strong sans title, not the editorial serif", () => {
    renderHomeFeed(imagePost());
    const title = screen.getByRole("heading", { name: "Golden Retriever near Riverside Park" });
    expect(title.className).toContain("fb-feed-title");
    expect(title.className).not.toContain("fb-editorial-title");
    expect(title.className).toMatch(/line-clamp-2/);
  });

  it("clamps the description and strips markdown", () => {
    renderHomeFeed(post({ description: "**Urgent**: lost near the *river* `trail`." }));
    const body = screen.getByTestId("post-description");
    expect(body.textContent).toBe("Urgent: lost near the river trail.");
    expect(body.className).toMatch(/line-clamp-2/);
  });

  it("omits the description element when empty", () => {
    renderHomeFeed(post({ description: "" }));
    expect(screen.queryByTestId("post-description")).toBeNull();
  });

  it("renders the location row when present and omits it cleanly when absent", () => {
    const target = post();
    const { rerender } = renderHomeFeed(target);
    expect(screen.getByTestId("post-location").textContent).toContain("Riverside Park, Austin, TX");
    rerender(
      <MemoryRouter>
        <FeedLoveProvider items={[post({ locationLabel: null })]} patchItem={vi.fn() as unknown as FeedPatchItem}>
          <PostCardContent post={post({ locationLabel: null })} layout="home-feed" />
        </FeedLoveProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("post-location")).toBeNull();
  });

  it("shows the category chip", () => {
    renderHomeFeed(post());
    expect(screen.getByTestId("post-category").textContent).toBe("Pets");
  });

  it("maps the semantic status chip over the five allowed labels only", () => {
    const cases: Array<{ type: PostType; status: PostStatus; label: string }> = [
      { type: "LOST", status: "OPEN", label: "Lost" },
      { type: "FOUND", status: "OPEN", label: "Found" },
      { type: "LOST", status: "MATCHED", label: "Matched" },
      { type: "LOST", status: "RECOVERED", label: "Recovered" },
      { type: "FOUND", status: "CLOSED", label: "Closed" },
    ];
    for (const { type, status, label } of cases) {
      const target = post({ type, status });
      const { unmount } = renderHomeFeed(target);
      const chip = screen.getByTestId("post-status-chip");
      expect(chip.textContent).toBe(label);
      unmount();
    }
  });

  it("has separate Like, Comments and Share controls outside the report link", () => {
    renderHomeFeed(imagePost());
    const detail = screen.getByTestId("home-feed-detail-link");
    const love = screen.getByTestId("home-feed-love");
    const comments = screen.getByRole("link", { name: /comments, 3/i });
    const share = screen.getByRole("button", { name: /share report/i });
    for (const control of [love, comments, share]) expect(detail.contains(control)).toBe(false);
    expect(comments.getAttribute("href")).toBe("/posts/p1#detail-comments");
    expect(love.textContent).toContain("24");
    expect(screen.getAllByText("24")).toHaveLength(1);
    expect(screen.queryByText("4.5")).toBeNull();
  });

  it("shares the selected report URL, not the feed URL", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    renderHomeFeed(imagePost());
    fireEvent.click(screen.getByRole("button", { name: /share report/i }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({
      title: "Golden Retriever near Riverside Park",
      url: "https://findback.test/r/p1",
    }));
  });

  it("copies the report link when Web Share fails, but not on dismissal", async () => {
    const share = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new DOMException("dismissed", "AbortError"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderHomeFeed(imagePost());
    fireEvent.click(screen.getByRole("button", { name: /share report/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "https://findback.test/r/p1",
    ));
    fireEvent.click(screen.getByRole("button", { name: /share report/i }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("keeps the author as quiet metadata without competing with the title", () => {
    renderHomeFeed(imagePost());
    expect(screen.getByTestId("post-author").textContent).toContain("@alice");
  });

  it("reserves image geometry while loading and falls back with a label on failure", () => {
    renderHomeFeed(imagePost());
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loading");
    expect(frame.className).toContain("fb-feed-img");
    fireEvent.error(screen.getByAltText("Photo for Golden Retriever near Riverside Park"));
    expect(screen.getByTestId("post-image-state").getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });

  it("renders a compact text-first card with no media box when there is no photo", () => {
    renderHomeFeed(post());
    expect(screen.queryByTestId("home-feed-no-photo")).toBeNull();
    expect(screen.queryByTestId("post-image-state")).toBeNull();
    expect(screen.queryByTestId("feed-media-viewport")).toBeNull();
    expect(screen.queryByTestId("carousel-dot")).toBeNull();
    // The report still reads: status, title, body, actions.
    expect(screen.getByTestId("post-status-chip")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Golden Retriever near Riverside Park" })).toBeTruthy();
    expect(screen.getByTestId("home-feed-actions")).toBeTruthy();
  });

  it("shows swipe dots instead of a badge for multiple photos, and none for one", () => {
    const { unmount } = renderHomeFeed(imagePost(3));
    expect(screen.queryByTestId("photo-count")).toBeNull();
    expect(screen.getAllByTestId("carousel-dot")).toHaveLength(3);
    unmount();
    renderHomeFeed(imagePost(1));
    expect(screen.queryAllByTestId("carousel-dot")).toHaveLength(0);
  });

  it("carries the shared media + title ids when enableSharedMedia", () => {
    feedFetchMock.mockResolvedValue({});
    render(
      <MemoryRouter>
        <FeedLoveProvider items={[imagePost()]} patchItem={vi.fn() as unknown as FeedPatchItem}>
          <PostCardContent post={imagePost()} layout="home-feed" enableSharedMedia />
        </FeedLoveProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("post-image-state").getAttribute("data-shared-media")).toBe(
      "fb-post-media-p1",
    );
    expect(
      screen
        .getByRole("heading", { name: "Golden Retriever near Riverside Park" })
        .getAttribute("data-shared-title"),
    ).toBe("fb-post-title-p1");
  });

  it("never conflates LOST/FOUND type with a resolved lifecycle state", () => {
    renderHomeFeed(
      imagePost(1, { type: "FOUND" as PostType, status: "RECOVERED" as PostStatus }),
    );
    // A recovered FOUND report reads as Recovered, never as the stale type.
    const chip = screen.getByTestId("post-status-chip");
    expect(chip.textContent).toBe("Recovered");
    expect(chip.getAttribute("data-status")).toBe("recovered");
  });

  it("keeps the card understandable to assistive tech in logical order", () => {
    renderHomeFeed(imagePost());
    const card = screen.getByTestId("home-feed-content");
    const order = within(card)
      .getAllByTestId(/post-status-chip|post-time|post-title|post-description|post-location|post-author|post-footer/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order[0]).toBe("post-status-chip");
    expect(order).toContain("post-title");
    expect(order.indexOf("post-title")).toBeGreaterThan(order.indexOf("post-status-chip"));
    expect(order.indexOf("post-footer")).toBeGreaterThan(order.indexOf("post-title"));
    // The action row is the last interactive region.
    expect(order.indexOf("post-footer")).toBe(order.length - 1);
  });

  it("meets the 44px minimum touch target on the Like toggle", () => {
    renderHomeFeed(imagePost());
    const love = screen.getByTestId("home-feed-love");
    expect(love.className).toMatch(/min-h-\[44px\]/);
    expect(love.className).toMatch(/min-w-\[44px\]/);
  });

  it("shows and announces a failure message when a Like toggle fails", async () => {
    const heard: string[] = [];
    const handler = (e: Event) => {
      heard.push((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("findback:announce", handler);
    try {
      renderHomeFeed(imagePost());
      loveToggleMock.mockRejectedValueOnce(new Error("offline"));
      fireEvent.click(screen.getByTestId("home-feed-love"));
      expect((await screen.findByTestId("home-feed-love-error")).textContent).toMatch(/try again/i);
      await waitFor(() => expect(heard.join(" ")).toMatch(/try again/i));
    } finally {
      window.removeEventListener("findback:announce", handler);
    }
  });

  it("disables the Like toggle while a toggle is in flight", async () => {
    let release!: (value: unknown) => void;
    loveToggleMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderHomeFeed(imagePost());
    const love = screen.getByTestId("home-feed-love") as HTMLButtonElement;
    expect(love.disabled).toBe(false);
    fireEvent.click(love);
    await waitFor(() => expect(love.disabled).toBe(true));
    release({ postId: "p1", likeCount: 25, dislikeCount: 1, myReaction: "LIKE" });
    await waitFor(() => expect(love.disabled).toBe(false));
  });

  it("exposes aria-busy while a Like toggle is in flight", async () => {
    let release!: (value: unknown) => void;
    loveToggleMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderHomeFeed(imagePost());
    const love = screen.getByTestId("home-feed-love");
    expect(love.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(love);
    await waitFor(() => expect(love.getAttribute("aria-busy")).toBe("true"));
    release({ postId: "p1", likeCount: 25, dislikeCount: 1, myReaction: "LIKE" });
    await waitFor(() => expect(love.getAttribute("aria-busy")).toBe("false"));
  });

  it("treats a rapid second tap as a silent no-op, never a false failure", async () => {
    const heard: string[] = [];
    const handler = (e: Event) => {
      heard.push((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("findback:announce", handler);
    try {
      let release!: (value: unknown) => void;
      loveToggleMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      renderHomeFeed(imagePost());
      const love = screen.getByTestId("home-feed-love");
      fireEvent.click(love);
      await waitFor(() => expect(love.getAttribute("data-pending")).toBe("true"));
      // Second tap lands while the first request is still in flight.
      fireEvent.click(love);
      // Exactly one request leaves the device; the second tap sends nothing.
      expect(loveToggleMock).toHaveBeenCalledTimes(1);
      release({ postId: "p1", likeCount: 25, dislikeCount: 1, myReaction: "LIKE" });
      await waitFor(() => expect(love.getAttribute("data-pending")).toBe("false"));
      expect(screen.queryByTestId("home-feed-love-error")).toBeNull();
      // And nothing was announced: no false failure reached the user.
      expect(heard.join(" ")).not.toMatch(/try again/i);
    } finally {
      window.removeEventListener("findback:announce", handler);
    }
  });
});

describe("home-feed detail link + Like action siblings (never nested)", () => {
  it("routes the card body through a detail link to the post", () => {
    renderHomeFeed(imagePost());
    const link = screen.getByTestId("home-feed-detail-link");
    expect(link.getAttribute("href")).toBe("/posts/p1");
    expect(link.textContent).toContain("Golden Retriever near Riverside Park");
  });

  it("renders the Like toggle as a sibling of the detail link, never inside it", () => {
    render(
      <MemoryRouter>
        <PostCard to="/posts/p1" index={0} variant="home-feed">
          <FeedLoveProvider items={[imagePost()]} patchItem={vi.fn() as unknown as FeedPatchItem}>
            <PostCardContent post={imagePost()} layout="home-feed" />
          </FeedLoveProvider>
        </PostCard>
      </MemoryRouter>,
    );
    const card = screen.getByTestId("post-card");
    const link = screen.getByTestId("home-feed-detail-link");
    const like = screen.getByRole("button", { name: /like/i });
    expect(card.contains(link)).toBe(true);
    expect(card.contains(like)).toBe(true);
    expect(link.contains(like)).toBe(false);
    expect(like.closest("a")).toBeNull();
    // No nested interactive controls anywhere in the card.
    expect(card.querySelector("a button")).toBeNull();
    expect(card.querySelector("button a")).toBeNull();
  });

  it("keeps the home-feed card shell free of a wrapping link (siblings own navigation)", () => {
    render(
      <MemoryRouter>
        <PostCard to="/posts/p1" index={5} variant="home-feed">
          <FeedLoveProvider items={[imagePost()]} patchItem={vi.fn() as unknown as FeedPatchItem}>
            <PostCardContent post={imagePost()} layout="home-feed" />
          </FeedLoveProvider>
        </PostCard>
      </MemoryRouter>,
    );
    const card = screen.getByTestId("post-card");
    // Main navigation and the comments shortcut are separate links.
    const links = card.querySelectorAll("a[href]");
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe("/posts/p1");
    expect(links[1]!.getAttribute("href")).toBe("/posts/p1#detail-comments");
  });
});

describe("home-feed Like/Unlike", () => {
  it("offers an unpressed Like toggle showing the live like count", async () => {
    renderHomeFeed(imagePost());
    await waitFor(() => expect(feedFetchMock).toHaveBeenCalledTimes(1));
    const love = screen.getByRole("button", { name: /like this report/i });
    expect(love.getAttribute("aria-pressed")).toBe("false");
    expect(love.textContent).toContain("24");
  });

  it("reflects a previously liked post as pressed after batch hydration", async () => {
    renderHomeFeed(imagePost(), {
      reactions: { p1: { myReaction: "LIKE", myRating: null } },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /liked/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("likes optimistically through LIKE and patches the feed cache item", async () => {
    loveToggleMock.mockResolvedValue({
      postId: "p1",
      likeCount: 30,
      dislikeCount: 1,
      myReaction: "LIKE",
    });
    const { patchItem } = renderHomeFeed(imagePost());
    await waitFor(() => expect(feedFetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /like this report/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /liked/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    // Like goes through the existing LIKE reaction — never a canonical kind.
    expect(loveToggleMock).toHaveBeenCalledWith("p1", null);
    // Optimistic patch (+1) then server reconciliation land in the feed cache.
    expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 25, dislikeCount: 1 });
    await waitFor(() =>
      expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 30, dislikeCount: 1 }),
    );
  });

  it("unlikes a liked post through null", async () => {
    loveToggleMock.mockResolvedValue({
      postId: "p1",
      likeCount: 23,
      dislikeCount: 1,
      myReaction: null,
    });
    const { patchItem } = renderHomeFeed(imagePost(), {
      reactions: { p1: { myReaction: "LIKE", myRating: null } },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /liked/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    patchItem.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /liked/i }));

    expect(loveToggleMock).toHaveBeenCalledWith("p1", "LIKE");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /like this report/i }).getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    expect(patchItem).toHaveBeenCalled();
  });
});

describe("home-feed media polish (edge-to-edge cover for loaded photos)", () => {
  it("marks a decoded photo loaded so the cover-crop style applies", () => {
    renderHomeFeed(imagePost());
    fireEvent.load(screen.getByAltText("Photo for Golden Retriever near Riverside Park"));
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loaded");
    expect(frame.className).toContain("fb-feed-img");
    // Loaded frames carry no placeholder/outline helper class.
    expect(frame.className).not.toContain("fb-feed-img-none");
  });

  it("keeps no-photo cards text-first with no fake image geometry", () => {
    renderHomeFeed(post());
    expect(screen.queryByTestId("home-feed-no-photo")).toBeNull();
    expect(screen.queryByTestId("feed-media-viewport")).toBeNull();
    expect(screen.getByRole("button", { name: /like/i })).toBeTruthy();
  });
});

describe("home-feed content-first interactions", () => {
  it("opens the canonical PhotoLightbox at the current carousel index on an image tap", () => {
    renderHomeFeed(imagePost(4));
    const track = screen.getByTestId("feed-media-track");
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    track.scrollLeft = 2 * 300;
    fireEvent.scroll(track);
    fireEvent.click(screen.getAllByTestId("feed-slide")[2]!);
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
    // Starts on the third photo, not the first.
    expect(screen.getByText("Photo 3 of 4")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "View photo 3" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("does not open the lightbox when the carousel is swiped", () => {
    renderHomeFeed(imagePost(4));
    const track = screen.getByTestId("feed-media-track");
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    track.scrollLeft = 300;
    fireEvent.scroll(track);
    const slide = screen.getAllByTestId("feed-slide")[1]!;
    fireEvent.mouseDown(slide, { clientX: 260, clientY: 30 });
    fireEvent.click(slide, { clientX: 30, clientY: 34 });
    expect(screen.queryByTestId("photo-lightbox")).toBeNull();
  });

  it("shows See more only when the description is actually truncated, and it navigates to detail", async () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
    // jsdom has no layout; drive a real truncation measurement.
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => 96 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 40 });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <FeedLoveProvider items={[imagePost()]} patchItem={vi.fn() as unknown as FeedPatchItem}>
            <PostCardContent post={imagePost()} layout="home-feed" />
          </FeedLoveProvider>
          <LocationProbe />
        </MemoryRouter>,
      );
      const more = await screen.findByTestId("post-description-more");
      expect(more.textContent).toMatch(/see more/i);
      expect(more.closest("a")?.getAttribute("href")).toBe("/posts/p1");
      fireEvent.click(more);
      await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/posts/p1"));
    } finally {
      if (scrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", scrollHeight);
      else delete (Element.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (clientHeight) Object.defineProperty(Element.prototype, "clientHeight", clientHeight);
      else delete (Element.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("omits See more when the description is not truncated", () => {
    renderHomeFeed(imagePost());
    expect(screen.queryByTestId("post-description-more")).toBeNull();
  });

  it("renders a flat action row reusing the existing love/comment/share controls", () => {
    renderHomeFeed(imagePost());
    const row = screen.getByTestId("home-feed-actions");
    expect(row.className).toMatch(/grid-cols-3/);
    // Flat: the reused controls' internal borders/backgrounds are neutralized
    // for both the button controls (love/share) and the comments link. The
    // trailing `!` (important) is REQUIRED — `.fb-report-action` is unlayered
    // plain CSS and otherwise beats Tailwind's @layer utilities regardless of
    // specificity (verified in Chromium against the compiled index.css).
    expect(row.className).toMatch(/\[&_button\]:border-0!/);
    expect(row.className).toMatch(/\[&_button\]:bg-transparent!/);
    expect(row.className).toMatch(/\[&_a\]:border-0!/);
    expect(row.className).toMatch(/\[&_a\]:bg-transparent!/);
    expect(screen.getByTestId("home-feed-love")).toBeTruthy();
    expect(screen.getByRole("link", { name: /comments, 3/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /share report/i })).toBeTruthy();
    // No giant bordered button cards: the old 3-column bordered grid is gone.
    expect(row.className).not.toMatch(/fb-report-actions/);
  });
});
