// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PostCardContent } from "./PostCardContent";

function postWithPhotos(count: number): PostItem {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "tester" },
    type: "LOST",
    status: "OPEN",
    title: "Lost camera",
    description: "plain description",
    category: "Electronics",
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
    attachments: Array.from({ length: count }, (_, i) => ({
      id: `a${i + 1}`,
      mimeType: "image/jpeg",
      fileUrl: `https://cdn.example/a${i + 1}.jpg`,
      displayOrder: i + 1,
    })),
  } as unknown as PostItem;
}

describe("PostCardContent photo counts (G17)", () => {
  afterEach(cleanup);

  it("editorial cards show the photo count", () => {
    render(<PostCardContent post={postWithPhotos(3)} layout="editorial" />);
    expect(screen.getByTestId("photo-count").textContent).toMatch(/3 photos/);
  });

  it("editorial cards show a singular count for one photo", () => {
    render(<PostCardContent post={postWithPhotos(1)} layout="editorial" />);
    expect(screen.getByTestId("photo-count").textContent).toMatch(/1 photo/);
  });

  it("compact cards show the photo count", () => {
    render(<PostCardContent post={postWithPhotos(5)} layout="compact" />);
    expect(screen.getByTestId("photo-count").textContent).toMatch(/5 photos/);
  });

  it("classic cards stay verbatim (no count badge)", () => {
    render(<PostCardContent post={postWithPhotos(3)} layout="classic" />);
    expect(screen.queryByTestId("photo-count")).toBeNull();
  });
});
