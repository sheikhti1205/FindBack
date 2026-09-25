// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PostCardContent } from "./PostCardContent";
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

function post(overrides: Partial<PostItem> = {}): PostItem {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "FOUND",
    status: "OPEN",
    title: "Black over-ear headphones",
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

function imagePost() {
  return post({
    attachments: [
      {
        id: "a1",
        fileUrl: "https://example.test/photo.jpg",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        fileSize: 10,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
    ],
  } as Partial<PostItem>);
}

describe("PostCardContent editorial (Home Variant A)", () => {
  it("renders kicker, serif headline, and a reserved image frame while loading", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" />);
    expect(screen.getByText("Found · Electronics · Open")).toBeTruthy();
    const title = screen.getByRole("heading", { name: "Black over-ear headphones" });
    expect(title.className).toContain("fb-editorial-title");
    expect(title.className).toContain("break-words");
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loading");
    // Space is reserved pre-load: the frame exists before the photo arrives.
    expect(frame.className).toContain("fb-img-frame");
    expect(screen.getByAltText("Photo for Black over-ear headphones")).toBeTruthy();
  });

  it("shows a labelled fallback with no layout shift when the photo fails", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" />);
    fireEvent.error(screen.getByAltText("Photo for Black over-ear headphones"));
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });

  it("renders text-only posts without an image box", () => {
    render(<PostCardContent post={post()} layout="editorial" />);
    expect(screen.getByText("No photo attached")).toBeTruthy();
    expect(screen.queryByTestId("post-image-state")).toBeNull();
  });
});

describe("PostCardContent compact (Search Variant B)", () => {
  it("renders a 64px thumb row with title and tag meta", () => {
    render(<PostCardContent post={imagePost()} layout="compact" />);
    expect(screen.getByRole("heading", { name: "Black over-ear headphones" })).toBeTruthy();
    expect(screen.getByText("Found · Electronics · Open")).toBeTruthy();
    expect(screen.getByTestId("post-image-state").className).toContain("fb-thumb");
  });

  it("keeps column rhythm with a no-photo tile", () => {
    render(<PostCardContent post={post()} layout="compact" />);
    expect(screen.getByText("No photo")).toBeTruthy();
  });
});

describe("PostCardContent classic default", () => {
  it("preserves the pre-U2 rendering when no layout is passed", () => {
    const { container } = render(<PostCardContent post={imagePost()} />);
    const img = container.querySelector("img");
    expect(img?.className).toContain("aspect-[4/3]");
    expect(screen.queryByTestId("post-image-state")).toBeNull();
  });
});

describe("PostList density", () => {
  const base = {
    loading: false,
    refreshing: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    onLoadMore: () => Promise.resolve(),
    onRetry: () => Promise.resolve(),
  };

  it("editorial density renders the photo-led layout", () => {
    render(
      <MemoryRouter>
        <PostList items={[imagePost()]} {...base} density="editorial" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Found · Electronics · Open")).toBeTruthy();
    expect(screen.getByTestId("post-image-state").className).toContain("fb-img-frame");
  });

  it("compact density renders thumb rows", () => {
    render(
      <MemoryRouter>
        <PostList items={[imagePost()]} {...base} density="compact" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("post-image-state").className).toContain("fb-thumb");
  });
});
