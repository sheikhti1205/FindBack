// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostItem } from "@findback/shared";

const { fetchPost } = vi.hoisted(() => ({ fetchPost: vi.fn() }));
vi.mock("../services/posts", () => ({ fetchPost }));

import { ReportReferenceCard } from "./ReportReferenceCard";
import { ReportPreviewProvider } from "./CommentReportPreviews";
import { ApiError } from "../services/session";

function post(overrides: Partial<PostItem> = {}): PostItem {
  return {
    id: "r1",
    userId: "u2",
    author: {
      id: "u2",
      username: "owner",
      displayName: null,
      avatarUrl: null,
      emailVerified: false,
      phoneVerified: false,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    type: "LOST",
    title: "Blue bike near the station",
    description: "",
    category: "Electronics",
    status: "OPEN",
    eventDate: "2026-09-01",
    latitude: null,
    longitude: null,
    locationLabel: "Central station",
    youtubeUrl: null,
    attachments: [
      {
        id: "a1",
        postId: "r1",
        fileUrl: "https://cdn.test/r1.jpg",
        mimeType: "image/jpeg",
        fileName: "r1.jpg",
        fileSize: 1000,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    likeCount: 0,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(postId: string | null) {
  return render(
    <MemoryRouter>
      <ReportPreviewProvider resetKey="u9">
        <p>
          <ReportReferenceCard postId={postId} />
        </p>
      </ReportPreviewProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  fetchPost.mockReset();
});

describe("ReportReferenceCard", () => {
  it("reserves the cover slot while loading and says nothing unavailable", () => {
    fetchPost.mockReturnValue(new Promise(() => {}));
    renderCard("r1");
    expect(screen.getByTestId("report-reference-loading")).toBeTruthy();
    expect(screen.getByText("Loading report")).toBeTruthy();
    expect(screen.queryByTestId("report-unavailable")).toBeNull();
    expect(screen.queryByText("Report unavailable")).toBeNull();
  });

  it("renders one link with the canonical status chip, title, author and location", async () => {
    fetchPost.mockResolvedValue(post());
    renderCard("r1");

    // Accessible name must carry the title exactly once: the query below only
    // matches a card whose computed name contains one occurrence.
    const link = await screen.findByRole("link", {
      name: (name) => name.split("Blue bike near the station").length - 1 === 1,
    });
    expect(link.getAttribute("href")).toBe("/posts/r1");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link.textContent).toContain("Blue bike near the station");
    expect(link.textContent).toContain("@owner");
    expect(link.textContent).toContain("Central station");
    const chip = screen.getByTestId("post-status-chip");
    expect(chip.textContent).toContain("Lost");
    // The cover is decorative: the adjacent title already names the link, so a
    // second copy in `alt` would make the accessible name announce it twice.
    expect(link.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
    expect(link.getAttribute("aria-label")).toBeNull();
  });

  it("uses only an image attachment for the cover", async () => {
    fetchPost.mockResolvedValue(
      post({
        attachments: [
          {
            id: "a1",
            postId: "r1",
            fileUrl: "https://cdn.test/r1.mp4",
            mimeType: "video/mp4",
            fileName: "r1.mp4",
            fileSize: 1000,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    );
    renderCard("r1");
    const link = await screen.findByRole("link");
    expect(link.querySelector("img")).toBeNull();
  });

  it("drops the cover instead of showing a broken-image glyph", async () => {
    fetchPost.mockResolvedValue(post());
    renderCard("r1");
    const img = (await screen.findByRole("link")).querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(screen.getByRole("link").querySelector("img")).toBeNull();
    expect(screen.getByTestId("report-reference").textContent).toContain(
      "Blue bike near the station",
    );
  });

  it("omits the location when the referenced report has none", async () => {
    fetchPost.mockResolvedValue(post({ locationLabel: null }));
    renderCard("r1");
    const link = await screen.findByRole("link");
    expect(link.textContent).not.toContain("Central station");
  });

  it("renders one unavailable node for a 404 target (state A)", async () => {
    fetchPost.mockRejectedValue(new ApiError("Post not found", 404));
    const { container } = renderCard("gone");
    const node = await screen.findByTestId("report-unavailable");
    expect(node.textContent).toBe("Report unavailable");
    expect(screen.getAllByTestId("report-unavailable")).toHaveLength(1);
    expect(container.textContent).toBe("Report unavailable");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the byte-identical node for a tombstone (state B, no network call)", () => {
    const { container } = renderCard(null);
    expect(screen.getByTestId("report-unavailable").textContent).toBe("Report unavailable");
    expect(container.textContent).toBe("Report unavailable");
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("renders the same DOM for state A and state B", async () => {
    fetchPost.mockRejectedValue(new ApiError("Post not found", 404));
    const a = renderCard("gone");
    await screen.findByTestId("report-unavailable");
    const aHtml = a.container.innerHTML;
    cleanup();

    const b = renderCard(null);
    expect(b.container.innerHTML).toBe(aHtml);
  });

  it("keeps a transport failure distinct, with a retry that succeeds", async () => {
    fetchPost.mockRejectedValueOnce(new ApiError("Server error", 400));
    renderCard("r1");
    const error = await screen.findByTestId("report-reference-error");
    expect(error.textContent).not.toContain("Report unavailable");
    expect(screen.queryByTestId("report-unavailable")).toBeNull();

    fetchPost.mockResolvedValueOnce(post());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link")).toBeTruthy();
  });
});
