// @vitest-environment jsdom
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function imagePost(count = 1, overrides: Partial<PostItem> = {}) {
  return post({ attachments: imageAttachments(count), ...overrides } as Partial<PostItem>);
}

function renderCard(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(cleanup);

describe("OwnerReportCard (My Reports owner-feed layout)", () => {
  it("uses a compact image-left/content-right layout, not a stacked hero", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const card = screen.getByTestId("owner-report-card");
    expect(card.className).toMatch(/grid/);
    // Image column precedes the content column in DOM order.
    const order = within(card)
      .getAllByTestId(/owner-report-(media|content)/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order[0]).toBe("owner-report-media");
    expect(order[1]).toBe("owner-report-content");
    // No stacked full-width hero image.
    expect(card.querySelector("img.aspect-\\[4\\/3\\]")).toBeNull();
  });

  it("shows a Lost badge with icon + text, and Found for found reports", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const badge = screen.getByTestId("owner-report-type");
    expect(badge.textContent).toMatch(/lost/i);
    expect(badge.querySelector("svg")).toBeTruthy();
    cleanup();
    renderCard(
      <OwnerReportCard post={imagePost(1, { type: "FOUND" as PostType })} />,
    );
    expect(screen.getByTestId("owner-report-type").textContent).toMatch(/found/i);
  });

  it("keeps the lifecycle status PROMINENT and always visible, even for OPEN", () => {
    const { rerender } = renderCard(<OwnerReportCard post={imagePost()} />);
    expect(screen.getByTestId("owner-report-status").textContent).toBe("Open");
    rerender(
      <MemoryRouter>
        <OwnerReportCard
          post={imagePost(1, { status: "MATCHED" as PostStatus })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("owner-report-status").textContent).toBe("Matched");
  });

  it("renders title, category, and posted age", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    expect(
      screen.getByRole("heading", { name: "Golden Retriever near Riverside Park" }),
    ).toBeTruthy();
    expect(screen.getByTestId("owner-report-category").textContent).toBe("Pets");
    expect(screen.getByTestId("owner-report-time").textContent).toMatch(/2h ago/);
  });

  it("shows a compact truthful engagement count: likes, comments, rating only", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const metrics = screen.getByTestId("owner-report-metrics");
    expect(metrics.textContent).toContain("24");
    expect(metrics.textContent).toContain("3");
    expect(metrics.textContent).toContain("4.5");
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?\s?km/);
    expect(screen.queryByText(/community reach|share count/i)).toBeNull();
  });

  it("does not repeat @currentUser on the owner card", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    expect(screen.getByTestId("owner-report-card").textContent).not.toContain("@alice");
  });

  it("crop the loaded image edge-to-edge: cover, no border, no letterbox", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const img = screen.getByAltText("Photo for Golden Retriever near Riverside Park");
    expect(img.className).toMatch(/object-cover/);
    expect(img.className).not.toMatch(/object-contain/);
    const frame = screen.getByTestId("owner-report-image");
    expect(frame.className).not.toMatch(/p-2|p-4|gap/);
  });

  it("reserves image geometry while loading and labels failures truthfully", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    expect(screen.getByTestId("owner-report-image").getAttribute("data-state")).toBe(
      "loading",
    );
    fireEvent.error(screen.getByAltText("Photo for Golden Retriever near Riverside Park"));
    expect(screen.getByTestId("owner-report-image").getAttribute("data-state")).toBe(
      "failed",
    );
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });

  it("renders a same-geometry placeholder when there is no photo", () => {
    renderCard(<OwnerReportCard post={post()} />);
    const placeholder = screen.getByTestId("owner-report-no-photo");
    expect(placeholder.textContent).toMatch(/no photo/i);
    expect(screen.queryByTestId("owner-report-image")).toBeNull();
  });

  it("opens the detail page from the whole card", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/posts/p1");
    expect(screen.getByTestId("owner-report-card").contains(link)).toBe(false);
    expect(link.contains(screen.getByTestId("owner-report-card"))).toBe(true);
  });

  it("exposes NO destructive status controls on the scrolling card", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const card = screen.getByTestId("owner-report-card");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(card.querySelector("select, input")).toBeNull();
    expect(card.textContent).not.toMatch(/delete|close report|mark recovered/i);
  });

  it("never conflates LOST/FOUND type with lifecycle state", () => {
    renderCard(
      <OwnerReportCard
        post={imagePost(1, { type: "FOUND" as PostType, status: "RECOVERED" as PostStatus })}
      />,
    );
    expect(screen.getByTestId("owner-report-type").textContent).toMatch(/found/i);
    expect(screen.getByTestId("owner-report-status").textContent).toBe("Recovered");
  });
});
