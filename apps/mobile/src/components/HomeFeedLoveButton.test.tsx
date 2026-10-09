// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeFeedLoveButton } from "./HomeFeedLoveButton";
import { FeedLoveProvider, type FeedPatchItem } from "../hooks/useFeedLove";

const { feedFetchMock, loveToggleMock, reactKindMock, rpcMock } = vi.hoisted(() => ({
  feedFetchMock: vi.fn(),
  loveToggleMock: vi.fn(),
  reactKindMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("../services/feedReactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/feedReactions")>();
  return {
    ...actual,
    fetchFeedReactionState: feedFetchMock,
    toggleLoveReaction: loveToggleMock,
    togglePostReactionKind: reactKindMock,
  };
});

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ rpc: rpcMock }),
}));

function post(): PostItem {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice", emailVerified: false, phoneVerified: false, avatarUrl: null, createdAt: twoHoursAgo },
    type: "LOST",
    status: "OPEN",
    title: "Lost dog",
    description: "Near the park.",
    category: "Pet Accessories",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: null,
    youtubeUrl: null,
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    likeCount: 24,
    dislikeCount: 1,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
  } as PostItem;
}

function renderButton(
  target: PostItem = post(),
  reactions: Record<string, { myReaction: "LIKE" | "DISLIKE" | "HELPFUL" | null; myRating: number | null }> = {},
) {
  feedFetchMock.mockResolvedValue(reactions);
  return render(
    <MemoryRouter>
      <FeedLoveProvider items={[target]} patchItem={vi.fn() as unknown as FeedPatchItem}>
        <HomeFeedLoveButton postId={target.id} likeCount={target.likeCount} />
      </FeedLoveProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  feedFetchMock.mockReset();
  loveToggleMock.mockReset();
  reactKindMock.mockReset();
  rpcMock.mockReset();
  feedFetchMock.mockResolvedValue({});
  loveToggleMock.mockResolvedValue({ postId: "p1", likeCount: 25, dislikeCount: 1, myReaction: "LIKE" });
  reactKindMock.mockResolvedValue({ counts: { LOVE: 24, HELPFUL: 1 }, myReaction: "HELPFUL", total: 25 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HomeFeedLoveButton reactions (W3.3)", () => {
  it("keeps the love testid, flat styling, and 44px targets", () => {
    renderButton();
    const love = screen.getByTestId("home-feed-love");
    expect(love.className).toMatch(/fb-report-action/);
    expect(love.className).toMatch(/min-h-\[44px\]/);
    expect(love.className).toMatch(/min-w-\[44px\]/);
    const choose = screen.getByTestId("home-feed-choose-reaction");
    expect(choose.getAttribute("aria-haspopup")).toBe("menu");
    expect(choose.className).toMatch(/min-h-\[44px\]/);
  });

  it("taps the default Love and unreacts on a second tap (real toggle path)", async () => {
    renderButton();
    const love = screen.getByTestId("home-feed-love");
    fireEvent.click(love);
    await waitFor(() => expect(loveToggleMock).toHaveBeenCalledWith("p1", null));
    await waitFor(() => expect(love.getAttribute("aria-label")).toMatch(/loved — tap to unlove/i));
    // Second tap sees the hydrated LIKE and clears it.
    fireEvent.click(love);
    await waitFor(() => expect(loveToggleMock).toHaveBeenLastCalledWith("p1", "LIKE"));
  });

  it("opens the tray on hold and selects a kind through the real kind path", async () => {
    vi.useFakeTimers();
    try {
      renderButton();
      const love = screen.getByTestId("home-feed-love");
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("reaction-tray")).toBeTruthy();
      // The hold's own click must not toggle.
      fireEvent.pointerUp(love);
      fireEvent.click(love);
      expect(loveToggleMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("reaction-option-HELPFUL"));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(reactKindMock).toHaveBeenCalledWith("p1", null, "HELPFUL"));
    expect(screen.queryByTestId("reaction-tray")).toBeNull();
  });

  it("cancels the tray when the hold becomes a scroll", () => {
    vi.useFakeTimers();
    try {
      renderButton();
      const love = screen.getByTestId("home-feed-love");
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      vi.advanceTimersByTime(350);
      fireEvent.pointerMove(love, { clientX: 10, clientY: 60 });
      vi.advanceTimersByTime(1000);
      expect(screen.queryByTestId("reaction-tray")).toBeNull();
      // It was a scroll, not a tap: no toggle either.
      expect(loveToggleMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the tray on pointercancel", () => {
    vi.useFakeTimers();
    try {
      renderButton();
      const love = screen.getByTestId("home-feed-love");
      fireEvent.pointerDown(love, { clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerCancel(love);
      vi.advanceTimersByTime(1000);
      expect(screen.queryByTestId("reaction-tray")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens via the Choose reaction button and selects with the keyboard (no long-press)", async () => {
    renderButton();
    fireEvent.click(screen.getByTestId("home-feed-choose-reaction"));
    const tray = await screen.findByTestId("reaction-tray");
    expect(screen.getByTestId("home-feed-choose-reaction").getAttribute("aria-expanded")).toBe("true");
    const loveOption = screen.getByTestId("reaction-option-LOVE");
    loveOption.focus();
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("reaction-option-HELPFUL");
    fireEvent.keyDown(tray, { key: "Enter" });
    await waitFor(() => expect(reactKindMock).toHaveBeenCalledWith("p1", null, "HELPFUL"));
  });

  it("labels the active kind (Helpful, N reactions) with aria-pressed", async () => {
    renderButton(post(), { p1: { myReaction: "HELPFUL", myRating: null } });
    const love = screen.getByTestId("home-feed-love");
    await waitFor(() => expect(love.getAttribute("aria-pressed")).toBe("true"));
    expect(love.getAttribute("aria-label")).toMatch(/helpful, 24 reactions/i);
  });

  it("announces a tray-write failure inline and reverts", async () => {
    const heard: string[] = [];
    const handler = (e: Event) => {
      heard.push((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("findback:announce", handler);
    try {
      reactKindMock.mockRejectedValueOnce(new Error("offline"));
      renderButton();
      fireEvent.click(screen.getByTestId("home-feed-choose-reaction"));
      fireEvent.click(await screen.findByTestId("reaction-option-WOW"));
      expect((await screen.findByTestId("home-feed-love-error")).textContent).toMatch(/try again/i);
      await waitFor(() => expect(heard.join(" ")).toMatch(/try again/i));
      expect(screen.getByTestId("home-feed-love").getAttribute("aria-pressed")).toBe("false");
    } finally {
      window.removeEventListener("findback:announce", handler);
    }
  });

  it("closes the tray on Escape", async () => {
    renderButton();
    fireEvent.click(screen.getByTestId("home-feed-choose-reaction"));
    const tray = await screen.findByTestId("reaction-tray");
    fireEvent.keyDown(tray, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("reaction-tray")).toBeNull());
  });
});
