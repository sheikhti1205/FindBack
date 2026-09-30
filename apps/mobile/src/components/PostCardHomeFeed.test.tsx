// @vitest-environment jsdom
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PostCardContent } from "./PostCardContent";

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

afterEach(cleanup);

describe("PostCardContent home-feed (reference-inspired Home layout)", () => {
  it("shows a Lost badge with icon + text and keeps time as a separate element", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
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
    render(
      <PostCardContent post={imagePost(1, { type: "FOUND" as PostType })} layout="home-feed" />,
    );
    const badge = screen.getByTestId("post-type-badge");
    expect(badge.textContent).toMatch(/found/i);
    expect(badge.querySelector("svg")).toBeTruthy();
  });

  it("uses a strong sans title, not the editorial serif", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
    const title = screen.getByRole("heading", { name: "Golden Retriever near Riverside Park" });
    expect(title.className).toContain("fb-feed-title");
    expect(title.className).not.toContain("fb-editorial-title");
    expect(title.className).toMatch(/line-clamp-2/);
  });

  it("clamps the description and strips markdown", () => {
    render(
      <PostCardContent
        post={post({ description: "**Urgent**: lost near the *river* `trail`." })}
        layout="home-feed"
      />,
    );
    const body = screen.getByTestId("post-description");
    expect(body.textContent).toBe("Urgent: lost near the river trail.");
    expect(body.className).toMatch(/line-clamp-2/);
  });

  it("omits the description element when empty", () => {
    render(<PostCardContent post={post({ description: "" })} layout="home-feed" />);
    expect(screen.queryByTestId("post-description")).toBeNull();
  });

  it("renders the location row when present and omits it cleanly when absent", () => {
    const { rerender } = render(<PostCardContent post={post()} layout="home-feed" />);
    expect(screen.getByTestId("post-location").textContent).toContain("Riverside Park, Austin, TX");
    rerender(<PostCardContent post={post({ locationLabel: null })} layout="home-feed" />);
    expect(screen.queryByTestId("post-location")).toBeNull();
  });

  it("shows the category chip and only non-OPEN lifecycle states", () => {
    const { rerender } = render(<PostCardContent post={post()} layout="home-feed" />);
    expect(screen.getByTestId("post-category").textContent).toBe("Pets");
    expect(screen.queryByTestId("post-lifecycle")).toBeNull();
    rerender(
      <PostCardContent post={post({ status: "MATCHED" as PostStatus })} layout="home-feed" />,
    );
    expect(screen.getByTestId("post-lifecycle").textContent).toBe("Matched");
  });

  it("summarises real engagement only: likes, comments, rating — no distance, no save", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
    const metrics = screen.getByTestId("post-metrics");
    expect(metrics.textContent).toContain("24");
    expect(metrics.textContent).toContain("3");
    expect(metrics.textContent).toContain("4.5");
    expect(screen.queryByRole("button", { name: /save|heart/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?\s?km/);
    expect(screen.queryByText(/nearby/i)).toBeNull();
  });

  it("keeps the author as quiet metadata without competing with the title", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
    expect(screen.getByTestId("post-author").textContent).toContain("@alice");
  });

  it("reserves image geometry while loading and falls back with a label on failure", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loading");
    expect(frame.className).toContain("fb-feed-img");
    fireEvent.error(screen.getByAltText("Photo for Golden Retriever near Riverside Park"));
    expect(screen.getByTestId("post-image-state").getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });

  it("renders a deliberate same-geometry placeholder when there is no photo", () => {
    render(<PostCardContent post={post()} layout="home-feed" />);
    const placeholder = screen.getByTestId("home-feed-no-photo");
    expect(placeholder.className).toContain("fb-feed-img");
    expect(placeholder.textContent).toMatch(/no photo/i);
    expect(screen.queryByTestId("post-image-state")).toBeNull();
    expect(screen.queryByTestId("photo-count")).toBeNull();
  });

  it("shows a truthful photo-count badge only for multiple photos", () => {
    const { rerender } = render(<PostCardContent post={imagePost(3)} layout="home-feed" />);
    expect(screen.getByTestId("photo-count").textContent).toMatch(/3 photos/);
    rerender(<PostCardContent post={imagePost(1)} layout="home-feed" />);
    expect(screen.queryByTestId("photo-count")).toBeNull();
  });

  it("carries the shared media + title ids when enableSharedMedia", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" enableSharedMedia />);
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
    render(
      <PostCardContent
        post={imagePost(1, { type: "FOUND" as PostType, status: "RECOVERED" as PostStatus })}
        layout="home-feed"
      />,
    );
    expect(screen.getByTestId("post-type-badge").textContent).toMatch(/found/i);
    expect(screen.getByTestId("post-lifecycle").textContent).toBe("Recovered");
  });

  it("keeps the card understandable to assistive tech in logical order", () => {
    render(<PostCardContent post={imagePost()} layout="home-feed" />);
    const card = screen.getByTestId("home-feed-content");
    const order = within(card)
      .getAllByTestId(/post-(type-badge|time)|post-title|post-description|post-location|post-footer/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order[0]).toBe("post-type-badge");
    expect(order).toContain("post-title");
    expect(order.indexOf("post-title")).toBeGreaterThan(order.indexOf("post-type-badge"));
    expect(order.indexOf("post-footer")).toBe(order.length - 1);
  });
});
