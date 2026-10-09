// @vitest-environment jsdom
import type { PostItem } from "@findback/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerReportCard } from "./OwnerReportCard";

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

afterEach(cleanup);

describe("OwnerReportCard lightbox (W7)", () => {
  it("opens the canonical PhotoLightbox at the tapped hero photo with prev/next", async () => {
    render(
      <MemoryRouter>
        <OwnerReportCard post={post({ attachments: imageAttachments(3) } as Partial<PostItem>)} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /open photo 1 of 3/i }));
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
    expect(screen.getByText("Photo 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next photo/i }));
    expect(screen.getByText("Photo 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /previous photo/i }));
    expect(screen.getByText("Photo 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close photo preview/i }));
    await waitFor(() => expect(screen.queryByTestId("photo-lightbox")).toBeNull());
  });

  it("keeps alt text, the broken-image fallback, and the content detail link", () => {
    render(
      <MemoryRouter>
        <OwnerReportCard post={post({ attachments: imageAttachments(1) } as Partial<PostItem>)} />
      </MemoryRouter>,
    );
    const img = screen.getByAltText("Photo for Golden Retriever near Riverside Park");
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/posts/p1");
    expect(link.textContent).toMatch(/golden retriever/i);
  });

  it("renders no photo button when there is no photo", () => {
    render(
      <MemoryRouter>
        <OwnerReportCard post={post()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("owner-report-no-photo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open photo/i })).toBeNull();
    expect(screen.queryByTestId("photo-lightbox")).toBeNull();
  });
});
