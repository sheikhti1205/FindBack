// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PostList } from "./PostList";

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

afterEach(() => {
  cleanup();
});

function post(id: string, title: string, overrides: Partial<PostItem> = {}): PostItem {
  return {
    id,
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "FOUND",
    status: "OPEN",
    title,
    description: "found on the library steps",
    category: "Electronics",
    eventDate: "2026-09-24",
    latitude: null,
    longitude: null,
    locationLabel: "Central Library",
    youtubeUrl: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    likeCount: 12,
    dislikeCount: 0,
    ratingAvg: 4,
    ratingCount: 2,
    commentCount: 3,
    attachments: [],
    ...overrides,
  } as PostItem;
}

const base = {
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  onLoadMore: () => Promise.resolve(),
  onRetry: () => Promise.resolve(),
};

function list(items: PostItem[]) {
  return (
    <MemoryRouter>
      <PostList items={items} {...base} density="compact" />
    </MemoryRouter>
  );
}

describe("PostList refresh contract", () => {
  it("renders no refresh text state: no Refreshing row while lists settle", () => {
    const { container } = render(list([post("p1", "Keys"), post("p2", "Wallet")]));
    expect(screen.queryByText(/refreshing/i)).toBeNull();
    expect(container.querySelector('[data-reconcile="enter"]')).toBeNull();
  });

  it("reconciles new rows with a short enter transition while seen rows stay untouched", () => {
    const { container, rerender } = render(list([post("p1", "Keys"), post("p2", "Wallet")]));
    // First paint is the baseline: nothing animates in.
    expect(container.querySelector('[data-reconcile="enter"]')).toBeNull();
    const keysBefore = screen.getByText("Keys");

    // A refresh returns one new report on top; the old rows keep their nodes.
    rerender(list([post("p3", "Camera"), post("p1", "Keys"), post("p2", "Wallet")]));
    expect(screen.getByText("Keys")).toBe(keysBefore);
    const entering = container.querySelectorAll('[data-reconcile="enter"]');
    expect(entering).toHaveLength(1);
    expect(entering[0]!.textContent).toMatch(/Camera/);
  });

  it("does not re-animate rows that were already reconciled", () => {
    const { container, rerender } = render(list([post("p1", "Keys")]));
    rerender(list([post("p1", "Keys"), post("p2", "Wallet")]));
    expect(container.querySelectorAll('[data-reconcile="enter"]')).toHaveLength(1);
    // Same items again: everything is seen, nothing enters.
    rerender(list([post("p1", "Keys"), post("p2", "Wallet")]));
    expect(container.querySelector('[data-reconcile="enter"]')).toBeNull();
  });
});

describe("PostList masonry density (CF-010)", () => {
  function masonryList(items: PostItem[], columns = 3) {
    return (
      <MemoryRouter>
        <PostList items={items} {...base} density="masonry" masonryColumns={columns} />
      </MemoryRouter>
    );
  }

  const photo = { id: "a1", postId: "p1", fileUrl: "https://example.test/a1.jpg", mimeType: "image/jpeg", fileName: "a1.jpg", fileSize: 1000, createdAt: "2026-09-24T00:00:00.000Z" };

  it("renders the ragged grid instead of a list of rows", () => {
    render(masonryList([post("p1", "Keys"), post("p2", "Wallet")]));
    expect(screen.getByTestId("feed-masonry")).toBeTruthy();
    expect(screen.getAllByTestId("feed-masonry-item")).toHaveLength(2);
  });

  it("uses the masonry card, whose photo keeps its own shape", () => {
    render(
      masonryList([
        post("p1", "Keys", { attachments: [{ ...photo, width: 1200, height: 900 }] as PostItem["attachments"] }),
        post("p2", "Wallet", { attachments: [photo] as PostItem["attachments"] }),
      ]),
    );
    const cards = screen.getAllByTestId("masonry-content");
    expect(cards).toHaveLength(2);
    const media = screen.getAllByTestId("masonry-media");
    // Known dimensions: the stored ratio, not a forced square and not a crop-all.
    expect(media[0]!.getAttribute("style")).toContain("1.3333333333333333");
    // Unknown dimensions: the documented placeholder ratio, so the box is never zero-height.
    expect(media[1]!.getAttribute("style")).toContain(`${4 / 3}`);
    expect(media[0]!.getAttribute("style")).not.toContain("1 / 1");
  });

  it("keeps a report with no photo as a text-first card", () => {
    render(masonryList([post("p1", "Keys")]));
    expect(screen.getByTestId("masonry-content")).toBeTruthy();
    expect(screen.queryByTestId("masonry-media")).toBeNull();
    expect(screen.getByTestId("masonry-detail-link")).toBeTruthy();
  });

  it("reserves the same grid while loading, so the first paint does not jump", () => {
    render(
      <MemoryRouter>
        <PostList items={[]} {...base} loading density="masonry" masonryColumns={2} />
      </MemoryRouter>,
    );
    const skeleton = screen.getByTestId("feed-skeleton-masonry");
    expect(skeleton.getAttribute("data-columns")).toBe("2");
    expect(skeleton.querySelectorAll("[data-testid='feed-skeleton-card']").length).toBeGreaterThan(0);
  });
});

describe("PostList pagination identity (CF-010 §10)", () => {
  it("shows the compact Morph capsule while the next page loads — not a spinner", () => {
    render(
      <MemoryRouter>
        <PostList items={[post("p1", "Keys")]} {...base} loadingMore hasMore />
      </MemoryRouter>,
    );

    const bar = screen.getByRole("status");
    expect(bar.textContent).toBe("Loading more…");
    expect(screen.getByTestId("morph-bar").className).toContain("bg-on-surface-variant");
    expect(bar.querySelector("svg")).toBeNull();
    // Nothing the reader is looking at is replaced: the loaded row is still there.
    expect(screen.getByText("Keys")).toBeTruthy();
  });

  it("keeps appended rows in place and drops the capsule when the page lands", () => {
    const { rerender } = render(
      <MemoryRouter>
        <PostList items={[post("p1", "Keys")]} {...base} loadingMore hasMore />
      </MemoryRouter>,
    );
    const loadedBefore = screen.getByText("Keys");

    rerender(
      <MemoryRouter>
        <PostList items={[post("p1", "Keys"), post("p2", "Wallet")]} {...base} hasMore />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("morph-bar")).toBeNull();
    // Same node for the row that was already on screen — no list replacement.
    expect(screen.getByText("Keys")).toBe(loadedBefore);
    expect(screen.getByText("Wallet")).toBeTruthy();
  });
});
