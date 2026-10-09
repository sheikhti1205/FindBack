// @vitest-environment jsdom
// W5 functional StatusChip colors: data-status → functional chip class, and
// the chip never binds the user accent (accent owns principal actions only).
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostCardContent } from "./PostCardContent";
import { FeedLoveProvider } from "../hooks/useFeedLove";

vi.mock("../services/feedReactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/feedReactions")>();
  return { ...actual, fetchFeedReactionState: vi.fn().mockResolvedValue({}) };
});

afterEach(cleanup);

function post(overrides: Partial<PostItem> = {}): PostItem {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status: "OPEN",
    title: "Lost wallet",
    description: "black leather",
    category: "Personal",
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
    commentCount: 0,
    attachments: [],
    ...overrides,
  } as PostItem;
}

function renderChip(target: PostItem) {
  return render(
    <MemoryRouter>
      <FeedLoveProvider items={[target]} patchItem={vi.fn()}>
        <PostCardContent post={target} layout="home-feed" />
      </FeedLoveProvider>
    </MemoryRouter>,
  );
}

describe("PostCardContent StatusChip functional colors (W5)", () => {
  it.each([
    { type: "LOST", status: "OPEN", kind: "lost", cls: "fb-status-lost" },
    { type: "FOUND", status: "OPEN", kind: "found", cls: "fb-status-found" },
    { type: "LOST", status: "MATCHED", kind: "matched", cls: "fb-status-matched" },
    { type: "FOUND", status: "MATCHED", kind: "matched", cls: "fb-status-matched" },
    { type: "LOST", status: "RECOVERED", kind: "recovered", cls: "fb-status-recovered" },
    { type: "LOST", status: "CLOSED", kind: "closed", cls: "fb-status-closed" },
  ] as Array<{ type: PostType; status: PostStatus; kind: string; cls: string }>)(
    "$status $type renders data-status=$kind with $cls",
    ({ type, status, kind, cls }) => {
      renderChip(post({ type, status }));
      const chip = screen.getByTestId("post-status-chip");
      expect(chip.getAttribute("data-status")).toBe(kind);
      expect(chip.className).toContain(cls);
      // Icon + text carry meaning, never color alone.
      expect(chip.querySelector("svg")).toBeTruthy();
    },
  );

  it("never binds the user accent: no accent/primary utility in any chip", () => {
    const cases: Array<{ type: PostType; status: PostStatus }> = [
      { type: "LOST", status: "OPEN" },
      { type: "FOUND", status: "OPEN" },
      { type: "LOST", status: "MATCHED" },
      { type: "LOST", status: "RECOVERED" },
      { type: "LOST", status: "CLOSED" },
    ];
    for (const { type, status } of cases) {
      const { unmount } = renderChip(post({ type, status }));
      const chip = screen.getByTestId("post-status-chip");
      expect(chip.className).not.toMatch(/primary|accent/);
      unmount();
    }
  });
});
