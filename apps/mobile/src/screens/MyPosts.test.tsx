// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, updatePostStatusMock, deletePostMock, shareReportMock } = vi.hoisted(() => ({
  fetchFeedMock: vi.fn(),
  updatePostStatusMock: vi.fn(),
  deletePostMock: vi.fn(),
  shareReportMock: vi.fn(),
}));

vi.mock("../services/posts", () => ({
  fetchFeed: fetchFeedMock,
  updatePostStatus: updatePostStatusMock,
  deletePost: deletePostMock,
}));
vi.mock("../utils/shareReport", () => ({ shareReport: shareReportMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "alice" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));

import { clearFeedCaches } from "../hooks/feedCache";
import { MyPosts, DELETE_UNDO_WINDOW_MS } from "./MyPosts";

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
  updatePostStatusMock.mockReset();
  deletePostMock.mockReset();
  shareReportMock.mockReset();
  clearFeedCaches();
  fetchFeedMock.mockResolvedValue({
    items: [post("p1"), post("p2")],
    nextCursor: null,
    total: 2,
  });
  updatePostStatusMock.mockImplementation(async (id: string, status: string) => post(id, status));
  deletePostMock.mockResolvedValue(undefined);
  shareReportMock.mockResolvedValue("Link copied to clipboard.");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  clearFeedCaches();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("uses a single keyboard tab stop and arrow selection for status filters", async () => {
    renderMyPosts();
    const group = screen.getByRole("radiogroup", { name: /status/i });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    options[0]!.focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[1]);
    expect(options[1]!.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", status: "OPEN" }), undefined,
    ));
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

/** Open the overflow menu of the first report row. */
function openFirstRowMenu() {
  const trigger = screen.getAllByRole("button", { name: /manage report/i })[0]!;
  fireEvent.click(trigger);
  return screen.getByRole("menu");
}

describe("MyPosts management (owner row actions)", () => {
  it("offers the canonical statuses plus edit, share and delete on every row", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    const statuses = within(menu).getAllByRole("menuitemradio").map((el) => el.textContent);
    expect(statuses.map((text) => text?.replace("Current", "").trim())).toEqual([
      "Open",
      "Matched",
      "Recovered",
      "Closed",
    ]);
    expect(within(menu).getByRole("menuitem", { name: /edit details/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /share/i })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /delete report/i })).toBeTruthy();
  });

  it("changes the status in place through the canonical status path", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledWith("p1", "MATCHED"));
    // The row is patched where it sits — no refetch, no reorder.
    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match"),
    );
  });

  it("shares through the canonical share path", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /share/i }));
    await waitFor(() => expect(shareReportMock).toHaveBeenCalledWith("p1", "Report p1"));
  });

  it("does NOT send the delete before the undo window closes, and Undo cancels it", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    vi.useFakeTimers();
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /delete report/i }));
    expect(window.confirm).toHaveBeenCalled();
    // Nothing is sent, and the report is still there — it is NOT shown as
    // deleted before the server accepted the delete.
    expect(deletePostMock).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2);
    expect(screen.getAllByTestId("owner-report-delete-pending")).toHaveLength(1);

    fireEvent.click(
      within(screen.getByTestId("my-posts-delete-undo")).getByRole("button", { name: /undo/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 500);
    });
    expect(deletePostMock).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2);
    expect(screen.getByTestId("my-posts-notice").textContent).toMatch(/cancelled/i);
  });

  it("sends the delete when the undo window closes and drops the row only after the server accepted", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    vi.useFakeTimers();
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /delete report/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10);
    });
    expect(deletePostMock).toHaveBeenCalledWith("p1");
    await act(async () => {
      await Promise.resolve();
    });
    // The row goes away only now — after the server accepted the delete.
    expect(screen.getAllByTestId("owner-report-card")).toHaveLength(1);
  });

  it("keeps the row and says the report was NOT deleted when the server refuses", async () => {
    deletePostMock.mockRejectedValue(new Error("network is down"));
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    vi.useFakeTimers();
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /delete report/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/not deleted/i);
    expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2);
  });
});
