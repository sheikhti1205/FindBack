// @vitest-environment jsdom
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
    toggleLoveReaction: loveToggleMock,
  };
});

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

afterEach(cleanup);

describe("PostCardContent home-feed (reference-inspired Home layout)", () => {
  it("shows a Lost badge with icon + text and keeps time as a separate element", () => {
    renderHomeFeed(imagePost());
    const badge = screen.getByTestId("post-type-badge");
    expect(badge.textContent).toMatch(/lost/i);
    // Icon + text redundancy: meaning must not be color-only.
    expect(badge.querySelector("svg")).toBeTruthy();
    const time = screen.getByTestId("post-time");
    expect(time.textContent).toMatch(/2h ago/);
    expect(time.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_CONTAINS).toBe(0);
    expect(badge.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_CONTAINS).toBe(0);
  });

  it("shows a Found badge with icon + text", () => {
    renderHomeFeed(imagePost(1, { type: "FOUND" as PostType }));
    const badge = screen.getByTestId("post-type-badge");
    expect(badge.textContent).toMatch(/found/i);
    expect(badge.querySelector("svg")).toBeTruthy();
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

  it("shows the category chip and only non-OPEN lifecycle states", () => {
    const { rerender } = renderHomeFeed(post());
    expect(screen.getByTestId("post-category").textContent).toBe("Pets");
    expect(screen.queryByTestId("post-lifecycle")).toBeNull();
    rerender(
      <MemoryRouter>
        <FeedLoveProvider items={[post({ status: "MATCHED" as PostStatus })]} patchItem={vi.fn() as unknown as FeedPatchItem}>
          <PostCardContent post={post({ status: "MATCHED" as PostStatus })} layout="home-feed" />
        </FeedLoveProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("post-lifecycle").textContent).toBe("Matched");
  });

  it("has separate Love, Comments and Share controls outside the report link", () => {
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
      url: `${window.location.origin}${window.location.pathname}#/posts/p1`,
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
      `${window.location.origin}${window.location.pathname}#/posts/p1`,
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

  it("renders a deliberate same-geometry placeholder when there is no photo", () => {
    renderHomeFeed(post());
    const placeholder = screen.getByTestId("home-feed-no-photo");
    expect(placeholder.className).toContain("fb-feed-img");
    expect(placeholder.textContent).toMatch(/no photo/i);
    expect(screen.queryByTestId("post-image-state")).toBeNull();
    expect(screen.queryByTestId("photo-count")).toBeNull();
  });

  it("shows a truthful photo-count badge only for multiple photos", () => {
    const { rerender } = renderHomeFeed(imagePost(3));
    expect(screen.getByTestId("photo-count").textContent).toMatch(/3 photos/);
    const single = imagePost(1);
    rerender(
      <MemoryRouter>
        <FeedLoveProvider items={[single]} patchItem={vi.fn() as unknown as FeedPatchItem}>
          <PostCardContent post={single} layout="home-feed" />
        </FeedLoveProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("photo-count")).toBeNull();
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

  it("never conflates LOST/FOUND type with lifecycle state", () => {
    renderHomeFeed(
      imagePost(1, { type: "FOUND" as PostType, status: "RECOVERED" as PostStatus }),
    );
    expect(screen.getByTestId("post-type-badge").textContent).toMatch(/found/i);
    expect(screen.getByTestId("post-lifecycle").textContent).toBe("Recovered");
  });

  it("keeps the card understandable to assistive tech in logical order", () => {
    renderHomeFeed(imagePost());
    const card = screen.getByTestId("home-feed-content");
    const order = within(card)
      .getAllByTestId(/post-(type-badge|time)|post-title|post-description|post-location|post-footer/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order[0]).toBe("post-type-badge");
    expect(order).toContain("post-title");
    expect(order.indexOf("post-title")).toBeGreaterThan(order.indexOf("post-type-badge"));
    expect(order.indexOf("post-footer")).toBe(order.length - 1);
  });

  it("meets the 44px minimum touch target on the Love toggle", () => {
    renderHomeFeed(imagePost());
    const love = screen.getByTestId("home-feed-love");
    expect(love.className).toMatch(/min-h-\[44px\]/);
    expect(love.className).toMatch(/min-w-\[44px\]/);
  });

  it("shows and announces a failure message when a Love toggle fails", async () => {
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

  it("disables the Love toggle while a toggle is in flight", async () => {
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

  it("exposes aria-busy while a Love toggle is in flight", async () => {
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

describe("home-feed detail link + Love action siblings (never nested)", () => {
  it("routes the card body through a detail link to the post", () => {
    renderHomeFeed(imagePost());
    const link = screen.getByTestId("home-feed-detail-link");
    expect(link.getAttribute("href")).toBe("/posts/p1");
    expect(link.textContent).toContain("Golden Retriever near Riverside Park");
  });

  it("renders the Love toggle as a sibling of the detail link, never inside it", () => {
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
    const love = screen.getByRole("button", { name: /love/i });
    expect(card.contains(link)).toBe(true);
    expect(card.contains(love)).toBe(true);
    expect(link.contains(love)).toBe(false);
    expect(love.closest("a")).toBeNull();
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

describe("home-feed Love/Unlove", () => {
  it("offers an unpressed Love toggle showing the live like count", async () => {
    renderHomeFeed(imagePost());
    await waitFor(() => expect(feedFetchMock).toHaveBeenCalledTimes(1));
    const love = screen.getByRole("button", { name: /love this report/i });
    expect(love.getAttribute("aria-pressed")).toBe("false");
    expect(love.textContent).toContain("24");
  });

  it("reflects a previously loved post as pressed after batch hydration", async () => {
    renderHomeFeed(imagePost(), {
      reactions: { p1: { myReaction: "LIKE", myRating: null } },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /loved/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("loves optimistically through LIKE and patches the feed cache item", async () => {
    loveToggleMock.mockResolvedValue({
      postId: "p1",
      likeCount: 30,
      dislikeCount: 1,
      myReaction: "LIKE",
    });
    const { patchItem } = renderHomeFeed(imagePost());
    await waitFor(() => expect(feedFetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /love this report/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /loved/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    // Love goes through the existing LIKE reaction — never a LOVE kind.
    expect(loveToggleMock).toHaveBeenCalledWith("p1", null);
    // Optimistic patch (+1) then server reconciliation land in the feed cache.
    expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 25, dislikeCount: 1 });
    await waitFor(() =>
      expect(patchItem).toHaveBeenCalledWith("p1", { likeCount: 30, dislikeCount: 1 }),
    );
  });

  it("unloves a loved post through null", async () => {
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
      expect(screen.getByRole("button", { name: /loved/i }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    patchItem.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /loved/i }));

    expect(loveToggleMock).toHaveBeenCalledWith("p1", "LIKE");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /love this report/i }).getAttribute("aria-pressed"),
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

  it("keeps the subtle outline placeholder only for no-photo cards", () => {
    renderHomeFeed(post());
    const placeholder = screen.getByTestId("home-feed-no-photo");
    expect(placeholder.className).toContain("fb-feed-img");
    expect(placeholder.className).toContain("fb-feed-img-none");
    expect(screen.getByRole("button", { name: /love/i })).toBeTruthy();
  });
});
