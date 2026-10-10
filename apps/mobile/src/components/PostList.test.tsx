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
