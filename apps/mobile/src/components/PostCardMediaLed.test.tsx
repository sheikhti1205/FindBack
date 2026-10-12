// @vitest-environment jsdom
// W7B-HOME (FBX-019) media-led structure: separators over container chrome.
import type { PostItem } from "@findback/shared";
import { cleanup, render, screen } from "@testing-library/react";
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
  const stamp = new Date(Date.now() - 3600 * 1000).toISOString();
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Golden Retriever near Riverside Park",
    description: "Our beloved dog Max went missing near the park entrance.",
    category: "Pets",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: "Riverside Park, Austin, TX",
    youtubeUrl: null,
    createdAt: stamp,
    updatedAt: stamp,
    likeCount: 24,
    dislikeCount: 1,
    ratingAvg: 4.5,
    ratingCount: 2,
    commentCount: 3,
    attachments: [
      {
        id: "a1",
        fileUrl: "https://cdn.example/a1.jpg",
        mimeType: "image/jpeg",
        fileName: "a1.jpg",
        fileSize: 10,
        createdAt: "2026-09-29T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as PostItem;
}

function renderShell() {
  return render(
    <MemoryRouter>
      <PostCard to="/posts/p1" index={5} variant="home-feed">
        <span>body</span>
      </PostCard>
    </MemoryRouter>,
  );
}

function renderContent(target: PostItem) {
  feedFetchMock.mockResolvedValue({});
  return render(
    <MemoryRouter>
      <FeedLoveProvider items={[target]} patchItem={vi.fn() as unknown as FeedPatchItem}>
        <PostCardContent post={target} layout="home-feed" />
      </FeedLoveProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  feedFetchMock.mockReset();
  loveToggleMock.mockReset();
  feedFetchMock.mockResolvedValue({});
});

afterEach(cleanup);

describe("W7B-HOME home-feed shell (separators over chrome)", () => {
  it("carries no card container chrome (no rounding, border box, or surface fill)", () => {
    renderShell();
    const card = screen.getByTestId("post-card");
    const shell = card.firstElementChild as HTMLElement;
    expect(shell.className).not.toMatch(/rounded-\[18px\]/);
    expect(shell.className).not.toMatch(/bg-surface-container-low/);
    expect(shell.className).not.toMatch(/overflow-hidden/);
    expect(shell.className).not.toMatch(/shadow/);
  });

  it("separates reports with a hairline + whitespace instead of a box", () => {
    renderShell();
    const card = screen.getByTestId("post-card");
    const shell = card.firstElementChild as HTMLElement;
    expect(shell.className).toMatch(/border-b/);
    expect(shell.className).toMatch(/border-outline-variant/);
    expect(shell.className).toMatch(/pb-5/);
  });
});

describe("W7B-HOME home-feed content (media-led block)", () => {
  it("renders the media in its own near-full-width region above inset text", () => {
    renderContent(post());
    const content = screen.getByTestId("home-feed-content");
    const media = screen.getByTestId("home-feed-media");
    const detail = screen.getByTestId("home-feed-detail-link");
    expect(content.contains(media)).toBe(true);
    // Media is a sibling of the detail link, never inside it.
    expect(detail.contains(media)).toBe(false);
    expect(media.contains(screen.getByTestId("feed-media-viewport"))).toBe(true);
    // Media region spans the block width; the text block insets separately.
    expect(media.className).toMatch(/fb-home-feed-media/);
    const textBlock = detail.parentElement as HTMLElement;
    expect(textBlock.className).toMatch(/px-4/);
  });

  it("keeps every feed contract testid/aria hook", () => {
    renderContent(post());
    for (const id of [
      "home-feed-content",
      "home-feed-media",
      "feed-media-viewport",
      "feed-media-track",
      "post-status-chip",
      "post-time",
      "home-feed-detail-link",
      "post-title",
      "post-description",
      "post-author",
      "post-location",
      "post-footer",
      "post-category",
      "home-feed-actions",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(
      screen.getByTestId("home-feed-actions").getAttribute("aria-label"),
    ).toBe("Report actions");
  });

  it("stays text-first with no media region when there is no photo", () => {
    renderContent(post({ attachments: [] }));
    expect(screen.queryByTestId("home-feed-media")).toBeNull();
    expect(screen.queryByTestId("feed-media-viewport")).toBeNull();
    expect(screen.getByTestId("home-feed-content")).toBeTruthy();
    expect(screen.getByTestId("home-feed-actions")).toBeTruthy();
  });
});
