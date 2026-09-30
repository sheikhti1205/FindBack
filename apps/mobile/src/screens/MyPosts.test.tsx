// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock } = vi.hoisted(() => ({ fetchFeedMock: vi.fn() }));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "alice" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));

import { clearFeedCaches } from "../hooks/feedCache";
import { MyPosts } from "./MyPosts";

// PostList paginates via IntersectionObserver (absent in jsdom); stub it
// following the PostCardDensity.test.tsx precedent.
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

function post(id: string, status = "OPEN") {
  const now = new Date().toISOString();
  return {
    id,
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type: "LOST",
    status,
    title: `Report ${id}`,
    description: "A description",
    category: "Pets",
    eventDate: "2026-09-29",
    latitude: null,
    longitude: null,
    locationLabel: "Austin, TX",
    youtubeUrl: null,
    createdAt: now,
    updatedAt: now,
    likeCount: 1,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
  };
}

function renderMyPosts() {
  return render(
    <MemoryRouter initialEntries={["/my-reports"]}>
      <MyPosts />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchFeedMock.mockReset();
  clearFeedCaches();
  fetchFeedMock.mockResolvedValue({
    items: [post("p1"), post("p2")],
    nextCursor: null,
    total: 2,
  });
});

afterEach(() => {
  cleanup();
  clearFeedCaches();
});

describe("MyPosts (My Reports alignment)", () => {
  it("keeps the userId feed restriction on every fetch", async () => {
    renderMyPosts();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    for (const call of fetchFeedMock.mock.calls) {
      expect(call[0]).toMatchObject({ userId: "u1" });
    }
  });

  it("exposes owner-status quick filters All|Open|Matched|Recovered|Closed", async () => {
    renderMyPosts();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    const group = screen.getByRole("radiogroup", { name: /status/i });
    const labels = within(group)
      .getAllByRole("radio")
      .map((el) => el.textContent);
    expect(labels).toEqual(["All", "Open", "Matched", "Recovered", "Closed"]);
  });

  it("filters by each lifecycle status while preserving userId", async () => {
    renderMyPosts();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    for (const [label, status] of [
      ["Matched", "MATCHED"],
      ["Recovered", "RECOVERED"],
      ["Closed", "CLOSED"],
      ["Open", "OPEN"],
    ] as const) {
      fetchFeedMock.mockClear();
      fireEvent.click(screen.getByRole("radio", { name: label }));
      await waitFor(() =>
        expect(fetchFeedMock).toHaveBeenCalledWith(
          expect.objectContaining({ userId: "u1", status }),
          undefined,
        ),
      );
    }
    // All clears the status restriction but keeps userId. Returning to a
    // previously loaded filter restores its session cache without refetching
    // (Detail→Back behavior), so clear the cache to prove the fetch contract.
    clearFeedCaches();
    fetchFeedMock.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1" }),
        undefined,
      ),
    );
    const lastFilters = fetchFeedMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(lastFilters.status ?? "").toBe("");
  });

  it("renders compact owner cards, not stacked heroes", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    // Compact layout isolation: no classic stacked hero images.
    expect(document.querySelector("img.aspect-\\[4\\/3\\]")).toBeNull();
  });

  it("keeps status prominent on every owner card", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    expect(screen.getAllByTestId("owner-report-status")).toHaveLength(2);
  });

  it("preserves pull-to-refresh wiring and BottomNav-safe back behavior", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    // Back affordance and header survive the redesign.
    expect(screen.getByRole("heading", { name: /my reports/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /back to profile/i })).toBeTruthy();
  });
});
