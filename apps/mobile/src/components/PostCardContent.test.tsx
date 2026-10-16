// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { afterEach, describe, expect, it } from "vitest";import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "framer-motion";
import { PostCardContent, sharedMediaLayoutId, sharedTitleLayoutId } from "./PostCardContent";

afterEach(cleanup);

const LONG = `a${"very".repeat(40)}longword`;

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

describe("masonry media failure (CF-010)", () => {
  const photo = {
    id: "a1",
    postId: "p1",
    fileUrl: "https://example.test/gone.jpg",
    mimeType: "image/jpeg",
    fileName: "gone.jpg",
    fileSize: 100,
    createdAt: "2026-09-01T00:00:00.000Z",
    width: 900,
    height: 1200,
  };

  it("says the photo is unavailable inside the reserved box, not as a broken image", () => {
    render(
      <MemoryRouter>
        <PostCardContent post={post({ title: "Keys", attachments: [photo] })} layout="masonry" />
      </MemoryRouter>,
    );

    const box = screen.getByTestId("masonry-media");
    const reserved = box.getAttribute("style");
    expect(box.querySelector("img")).toBeTruthy();

    fireEvent.error(box.querySelector("img")!);

    expect(screen.getByTestId("masonry-media-fallback").textContent).toContain("Photo unavailable");
    // The broken <img> is gone rather than left behind the fallback.
    expect(screen.getByTestId("masonry-media").querySelector("img")).toBeNull();
    // The true-ratio box is untouched: a failure never re-packs the grid.
    expect(screen.getByTestId("masonry-media").getAttribute("style")).toBe(reserved);
    // Decorative: the button above already names itself for assistive tech.
    expect(screen.getByTestId("masonry-media-fallback").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("masonry-media").getAttribute("aria-label")).toBe("Photo for Keys");
  });
});

describe("PostCardContent overflow", () => {
  it("breaks long unbroken titles and excerpts instead of overflowing", () => {
    const { container } = render(<PostCardContent post={post({ title: LONG, description: LONG })} />);
    expect(screen.getByText(LONG, { selector: "h3" }).className).toContain("break-words");
    const excerpt = container.querySelector("p");
    expect(excerpt?.textContent).toContain(LONG);
    expect(excerpt?.className).toContain("break-words");
  });
});

function imagePost(): PostItem {
  return post({
    attachments: [
      {
        id: "a1",
        postId: "p1",
        fileUrl: "https://example.test/photo.jpg",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        fileSize: 10,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
}

describe("PostCardContent shared card → detail element (Wave A)", () => {
  it("exposes media/title shared ids keyed by post id when enabled", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" enableSharedMedia />);
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-shared-media")).toBe(sharedMediaLayoutId("p1"));
    expect(frame.getAttribute("data-shared-media")).toBe("fb-post-media-p1");
    expect(screen.getByRole("heading").getAttribute("data-shared-title")).toBe(
      sharedTitleLayoutId("p1"),
    );
  });

  it("carries no shared ids by default so stray cards never duplicate a layoutId", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" />);
    expect(screen.getByTestId("post-image-state").getAttribute("data-shared-media")).toBeNull();
    expect(screen.getByRole("heading").getAttribute("data-shared-title")).toBeNull();
  });

  it("classic layout shares the media id when enabled", () => {
    render(<PostCardContent post={imagePost()} enableSharedMedia />);
    expect(screen.getByAltText("Photo for Lost wallet").getAttribute("data-shared-media")).toBe(
      "fb-post-media-p1",
    );
  });
});

describe("PostCardContent image crossfade (Wave A)", () => {
  it("reserves the frame while loading and settles to loaded without unmounting", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" />);
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loading");
    const img = screen.getByAltText("Photo for Lost wallet");
    fireEvent.load(img);
    // Same frame element transitions loading → loaded: no layout shift.
    expect(screen.getByTestId("post-image-state").getAttribute("data-state")).toBe("loaded");
    expect(screen.getByAltText("Photo for Lost wallet")).toBeTruthy();
  });

  it("transitions to a labelled fallback when the photo fails", () => {
    render(<PostCardContent post={imagePost()} layout="editorial" />);
    fireEvent.error(screen.getByAltText("Photo for Lost wallet"));
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });

  it("still renders content under forced reduced motion", () => {
    render(
      <MotionConfig reducedMotion="always">
        <PostCardContent post={imagePost()} layout="editorial" enableSharedMedia />
      </MotionConfig>,
    );
    expect(screen.getByRole("heading", { name: "Lost wallet" })).toBeTruthy();
    expect(screen.getByAltText("Photo for Lost wallet")).toBeTruthy();
  });
});
