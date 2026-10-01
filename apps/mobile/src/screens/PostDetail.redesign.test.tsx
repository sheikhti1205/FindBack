// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: {},
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: vi.fn() },
}));

const { postsMock, findMock, authState } = vi.hoisted(() => ({
  postsMock: {
    fetchPost: vi.fn(),
    fetchComments: vi.fn(),
    fetchSocialState: vi.fn(),
    addComment: vi.fn(),
    deleteComment: vi.fn(),
    ratePost: vi.fn(),
    reactToPost: vi.fn(),
    updatePostStatus: vi.fn(),
  },
  findMock: vi.fn(),
  authState: { user: { id: "u9", username: "reader" } as { id: string; username: string } | null },
}));

vi.mock("../services/posts", () => postsMock);
vi.mock("../services/realtime", () => ({
  joinPostRoom: vi.fn(),
  leavePostRoom: vi.fn(),
  onRealtime: vi.fn(() => () => {}),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../services/possibleMatches", () => ({ findPossibleMatches: findMock }));

import { PostDetail } from "./PostDetail";
import { DEFAULT_APPEARANCE, saveAppearance } from "../appearance";

const LONG_DESC = `# Lost wallet\n\nThis is a **very long** description with [a link](https://example.com). `.repeat(30);

const basePost = {
  id: "p1",
  userId: "u2",
  author: { id: "u2", username: "owner" },
  type: "LOST",
  status: "OPEN",
  title: "Lost wallet",
  description: LONG_DESC,
  category: "Accessories",
  eventDate: "2026-09-01",
  latitude: 23.8,
  longitude: 90.4,
  locationLabel: "Central Park",
  youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  likeCount: 4,
  dislikeCount: 1,
  ratingAvg: 4.5,
  ratingCount: 2,
  commentCount: 7,
  attachments: [
    { id: "a1", mimeType: "image/jpeg", fileUrl: "https://cdn.example/a1.jpg", displayOrder: 1 },
    { id: "a2", mimeType: "image/jpeg", fileUrl: "https://cdn.example/a2.jpg", displayOrder: 2 },
  ],
};

function comment(i: number) {
  return {
    id: `c${i}`,
    postId: "p1",
    body: `comment body ${i}`,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    author: { id: `u${i}`, username: `user${i}` },
  };
}

function renderDetail(entry = "/posts/p1") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/posts/:id" element={<PostDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PostDetail redesign (UXN-3)", () => {
  beforeEach(() => {
    authState.user = { id: "u9", username: "reader" };
    postsMock.fetchPost.mockResolvedValue(basePost);
    postsMock.fetchComments.mockResolvedValue([0, 1, 2, 3, 4, 5, 6].map(comment));
    postsMock.fetchSocialState.mockResolvedValue({ myReaction: null, myRating: null });
    findMock.mockResolvedValue({ available: true, candidatesConsidered: 2, matches: [] });
  });

  afterEach(cleanup);

  it("collapses a long description with Show more/less + aria-expanded", async () => {
    renderDetail();
    const more = await screen.findByRole("button", { name: /show more/i });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const less = await screen.findByRole("button", { name: /show less/i });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(await screen.findByRole("button", { name: /show more/i })).toBeTruthy();
  });

  it("comments action scrolls to the Comments section", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    renderDetail();
    const action = await screen.findByRole("button", { name: /comments, 7/i });
    fireEvent.click(action);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("uses instant scroll under reduced motion", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    try {
      renderDetail();
      const anchor = await screen.findByRole("button", { name: /comments, 7/i });
      fireEvent.click(anchor);
      expect(scrollSpy).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "instant" }),
      );
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });

  it("honors the FindBack Reduce Motion override even when the OS reports full motion", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      // OS reports FULL motion — the app-level override must still win.
      value: () => ({
        matches: false,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "reduce" });
    try {
      renderDetail();
      const anchor = await screen.findByRole("button", { name: /comments, 7/i });
      fireEvent.click(anchor);
      expect(scrollSpy).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "instant" }),
      );
    } finally {
      saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "system" });
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
    }
  });

  it("map and YouTube are absent until their disclosures open", async () => {
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByTestId("interactive-location-map")).toBeNull();
    expect(screen.queryByTestId("youtube-poster")).toBeNull();
    expect(screen.queryByTestId("youtube-player")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /view map/i }));
    expect(await screen.findByTestId("interactive-location-map")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /video attached/i }));
    expect(await screen.findByTestId("youtube-poster")).toBeTruthy();
  });

  it("shows >5 comments collapsed with View all N comments", async () => {
    renderDetail();
    await screen.findByText("comment body 0");
    expect(screen.queryByText("comment body 6")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /view all 7 comments/i }));
    expect(await screen.findByText("comment body 6")).toBeTruthy();
  });

  it("owner Manage report card renders near the top and only for the owner", async () => {
    authState.user = { id: "u2", username: "owner" };
    const { container } = renderDetail();
    const manage = await screen.findByRole("region", { name: /manage report/i });
    const article = container.querySelector("article")!;
    // Manage card must be inside the top article flow, before the overview section.
    expect(article.contains(manage)).toBe(true);
    const overview = await screen.findByTestId("detail-overview");
    expect(manage.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides owner controls from non-owners", async () => {
    authState.user = { id: "u9", username: "reader" };
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: /manage report/i })).toBeNull();
  });

  it("social row keeps Love with count, share copies without a count", async () => {
    postsMock.reactToPost.mockResolvedValue({ likeCount: 5, dislikeCount: 1 });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard, share: undefined });
    renderDetail();
    const love = await screen.findByRole("button", { name: /love, 4/i });
    fireEvent.click(love);
    await waitFor(() => expect(postsMock.reactToPost).toHaveBeenCalledWith("p1", "LIKE"));
    const share = screen.getByRole("button", { name: /share/i });
    expect(share.textContent).not.toMatch(/\d/);
    fireEvent.click(share);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
  });

  it("feed comment links scroll and move focus to the existing comments section", async () => {
    const targets: Element[] = [];
    Element.prototype.scrollIntoView = function () { targets.push(this); };
    renderDetail("/posts/p1#detail-comments");
    const comments = await screen.findByTestId("detail-comments");
    await waitFor(() => expect(targets).toContain(comments));
    expect(document.activeElement).toBe(comments);
  });

  it("uses vertical sections, with a distinct average and personal rating", async () => {
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: /report sections/i })).toBeNull();
    const rating = screen.getByRole("region", { name: /community rating/i });
    expect(rating.textContent).toContain("4.5");
    expect(screen.getByRole("radiogroup", { name: /your rating/i })).toBeTruthy();
    const summary = screen.getByRole("region", { name: /report summary/i });
    const hero = screen.getByTestId("detail-hero-stage");
    expect(summary.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rating.compareDocumentPosition(screen.getByTestId("detail-overview")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("matches section carries the suggestions disclaimer", async () => {
    renderDetail();
    expect(await screen.findByText(/suggestions, not confirmed matches/i)).toBeTruthy();
  });
});
