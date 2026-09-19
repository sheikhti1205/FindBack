// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { afterEach, describe, expect, it } from "vitest";import { cleanup, render, screen } from "@testing-library/react";
import { PostCardContent } from "./PostCardContent";

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

describe("PostCardContent overflow (WP15 #37)", () => {
  it("breaks long unbroken titles and excerpts instead of overflowing", () => {
    const { container } = render(<PostCardContent post={post({ title: LONG, description: LONG })} />);
    expect(screen.getByText(LONG, { selector: "h3" }).className).toContain("break-words");
    const excerpt = container.querySelector("p");
    expect(excerpt?.textContent).toContain(LONG);
    expect(excerpt?.className).toContain("break-words");
  });
});
