// @vitest-environment jsdom
import type { PostItem, PostStatus, PostType } from "@findback/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerReportCard } from "./OwnerReportCard";
import { OwnerReportActionsProvider } from "./OwnerReportActions";

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
    expect(screen.getByTestId("owner-report-status").textContent).toContain("Still missing");
    rerender(
      <MemoryRouter>
        <OwnerReportCard
          post={imagePost(1, { status: "MATCHED" as PostStatus })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("owner-report-status").textContent).toContain("Potential match");
  });

  it("does not describe an open Found report as missing", () => {
    renderCard(<OwnerReportCard post={imagePost(1, { type: "FOUND" })} />);
    expect(screen.getByTestId("owner-report-status").textContent).toContain("Awaiting owner");
    expect(screen.queryByText(/still missing/i)).toBeNull();
  });

  it("renders title, category, and posted age", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    expect(
      screen.getByRole("heading", { name: "Golden Retriever near Riverside Park" }),
    ).toBeTruthy();
    expect(screen.getByTestId("owner-report-category").textContent).toBe("Pets");
    expect(screen.getByTestId("owner-report-time").textContent).toMatch(/2h ago/);
  });

  it("shows owner engagement without duplicating the Detail-only rating", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const metrics = screen.getByTestId("owner-report-metrics");
    expect(metrics.textContent).toContain("24");
    expect(metrics.textContent).toContain("3");
    expect(metrics.textContent).not.toContain("4.5");
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

  it("opens the detail page from the content link while the photo opens the lightbox", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/posts/p1");
    expect(link.getAttribute("data-testid")).toBe("owner-report-content");
    expect(screen.getByTestId("owner-report-card").contains(link)).toBe(true);
    // The photo is a sibling tap target, never nested inside the link.
    const photoButton = screen.getByRole("button", { name: /open photo/i });
    expect(link.contains(photoButton)).toBe(false);
    fireEvent.click(photoButton);
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
  });

  it("exposes NO destructive status controls on the scrolling card", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    const card = screen.getByTestId("owner-report-card");
    // Only the photo viewer button; no status/delete controls.
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/open photo/i),
    ]);
    expect(card.querySelector("select, input")).toBeNull();
    expect(card.textContent).not.toMatch(/delete|close report|mark recovered/i);
  });

  it("shows where and when the item was lost or found", () => {
    renderCard(<OwnerReportCard post={imagePost()} />);
    expect(screen.getByTestId("owner-report-location").textContent).toContain("Riverside Park");
    expect(screen.getByTestId("owner-report-event-date").textContent).toMatch(/2026/);
  });

  it("reveals the next lifecycle step on a swipe and runs it through the owner handler", () => {
    const onChangeStatus = vi.fn();
    render(
      <MemoryRouter>
        <OwnerReportActionsProvider
          value={{
            onChangeStatus,
            onEdit: vi.fn(),
            onShare: vi.fn(),
            onDelete: vi.fn(),
          }}
        >
          <OwnerReportCard post={imagePost()} />
        </OwnerReportActionsProvider>
      </MemoryRouter>,
    );

    const swipe = screen.getByTestId("owner-status-swipe-surface");
    fireEvent.pointerDown(swipe, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(swipe, { pointerId: 1, pointerType: "touch", clientX: 130, clientY: 100 });
    fireEvent.pointerUp(swipe, { pointerId: 1, pointerType: "touch", clientX: 130, clientY: 100 });

    fireEvent.click(screen.getByRole("button", { name: "Mark matched" }));
    expect(onChangeStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "MATCHED");
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
