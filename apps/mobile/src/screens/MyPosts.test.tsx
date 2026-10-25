// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, updatePostStatusMock, deletePostMock, shareReportMock, copyReportLinkMock } =
  vi.hoisted(() => ({
    fetchFeedMock: vi.fn(),
    updatePostStatusMock: vi.fn(),
    deletePostMock: vi.fn(),
    shareReportMock: vi.fn(),
    copyReportLinkMock: vi.fn(),
  }));

vi.mock("../services/posts", () => ({
  fetchFeed: fetchFeedMock,
  updatePostStatus: updatePostStatusMock,
  deletePost: deletePostMock,
}));
vi.mock("../utils/shareReport", () => ({
  shareReport: shareReportMock,
  copyReportLink: copyReportLinkMock,
}));
const { authState } = vi.hoisted(() => ({
  authState: { user: { id: "u1", username: "alice" } as { id: string; username: string } | null },
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));

// The recovery sheet has its own suite; here it stands in as the one
// confirmation surface so the screen's routing and row patch are provable.
const { recoverySheet } = vi.hoisted(() => ({
  recoverySheet: { open: false, post: null as unknown, onRecovered: null as unknown, onRate: null as unknown },
}));
vi.mock("../components/RecoverySheet", () => ({
  RecoverySheet: (props: {
    open: boolean;
    post: unknown;
    onRecovered?: (id: string, post: unknown) => void;
    onRate?: () => void;
  }) => {
    recoverySheet.open = props.open;
    recoverySheet.post = props.post;
    recoverySheet.onRecovered = props.onRecovered;
    recoverySheet.onRate = props.onRate;
    if (!props.open) return null;
    return (
      <button type="button" onClick={() => props.onRecovered?.("ret-1", props.post)}>
        confirm recovery
      </button>
    );
  },
}));

import { clearFeedCaches, invalidateFeedCaches } from "../hooks/feedCache";
import { MyPosts, DELETE_UNDO_WINDOW_MS } from "./MyPosts";
import { ReportDeletionFeedbackProvider } from "../components/ReportDeletionFeedback";

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

function post(id: string, status = "OPEN", type: "LOST" | "FOUND" = "LOST") {
  const now = new Date().toISOString();
  return {
    id,
    userId: "u1",
    author: { id: "u1", username: "alice" },
    type,
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
      <ReportDeletionFeedbackProvider><MyPosts /></ReportDeletionFeedbackProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchFeedMock.mockReset();
  updatePostStatusMock.mockReset();
  deletePostMock.mockReset();
  shareReportMock.mockReset();
  copyReportLinkMock.mockReset();
  copyReportLinkMock.mockResolvedValue({ status: "copied" });
  clearFeedCaches();
  authState.user = { id: "u1", username: "alice" };
  recoverySheet.open = false;
  recoverySheet.post = null;
  recoverySheet.onRecovered = null;
  recoverySheet.onRate = null;
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
    expect(within(menu).getByRole("menuitem", { name: /copy link/i })).toBeTruthy();
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

  it("refuses a status change on an already-recovered report without a write", async () => {
    fetchFeedMock.mockResolvedValue({
      items: [post("p1", "RECOVERED"), post("p2")],
      nextCursor: null,
      total: 2,
    });
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /^open/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/already recorded as recovered/i),
    );
    expect(updatePostStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("my-posts-status-undo")).toBeNull();
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Recovered");
  });

  it("shows the chosen status immediately and rolls it back when the write fails", async () => {
    let rejectWrite: (error: Error) => void = () => {};
    const pendingWrite = new Promise((_resolve, reject) => {
      rejectWrite = reject;
    });
    updatePostStatusMock.mockReturnValueOnce(pendingWrite);
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));

    // Optimistic: the row changed before the server answered.
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match");
    expect(screen.getByTestId("my-posts-status-undo")).toBeTruthy();

    await act(async () => {
      rejectWrite(new Error("network down"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Still missing"),
    );
    expect(screen.queryByTestId("my-posts-status-undo")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/network problem/i);
  });

  it("rolls a change and an early Undo back to the last server-confirmed status when both writes fail", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    let rejectSecond: (error: Error) => void = () => {};
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise((_resolve, reject) => {
      rejectSecond = reject;
    });
    updatePostStatusMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));

    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match");

    // Undo before the original write settles. Both writes are optimistic;
    // neither may become the rollback target when both are refused.
    fireEvent.click(within(screen.getByTestId("my-posts-status-undo")).getByRole("button", { name: /undo/i }));
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Still missing");

    await act(async () => {
      rejectFirst(new Error("network down"));
      await Promise.resolve();
    });
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenLastCalledWith("p1", "OPEN"));

    await act(async () => {
      rejectSecond(new Error("network still down"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Still missing"),
    );
    expect(screen.queryByTestId("my-posts-status-undo")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/network problem/i);
  });

  it("rolls a failed second change back to the first change's confirmed status", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let rejectSecond: (error: Error) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((_resolve, reject) => {
      rejectSecond = reject;
    });
    updatePostStatusMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));

    let menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(1));

    menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /closed/i }));
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Closed");

    // The first write settles successfully while the second is queued; its
    // MATCHED is now the server truth and must be the second failure's target.
    await act(async () => {
      resolveFirst(post("p1", "MATCHED"));
      await Promise.resolve();
    });
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenLastCalledWith("p1", "CLOSED"));

    await act(async () => {
      rejectSecond(new Error("network down"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match"),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/network problem/i);
  });

  it("rolls a failed Undo back to the change that settled while the Undo was in flight", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let rejectSecond: (error: Error) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((_resolve, reject) => {
      rejectSecond = reject;
    });
    updatePostStatusMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));

    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(1));

    fireEvent.click(within(screen.getByTestId("my-posts-status-undo")).getByRole("button", { name: /undo/i }));
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Still missing");

    // The original change lands MATCHED while the Undo waits. The Undo's
    // failure must restore that confirmed status, not the optimistic OPEN.
    await act(async () => {
      resolveFirst(post("p1", "MATCHED"));
      await Promise.resolve();
    });
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenLastCalledWith("p1", "OPEN"));

    await act(async () => {
      rejectSecond(new Error("network down"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match"),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/network problem/i);
  });

  it("restores the previous status from the Undo snackbar", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Potential match"),
    );

    const undo = screen.getByTestId("my-posts-status-undo");
    fireEvent.click(within(undo).getByRole("button", { name: /undo/i }));

    await waitFor(() => expect(updatePostStatusMock).toHaveBeenLastCalledWith("p1", "OPEN"));
    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Still missing"),
    );
    expect(screen.getByTestId("my-posts-notice").textContent).toMatch(/restored to still missing/i);
  });

  it("serializes rapid status writes and keeps the last choice", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    updatePostStatusMock
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(post("p1", "CLOSED"));
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));

    let menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(1));

    // The second choice is optimistic immediately, but its write must wait
    // for the first so the server's final state is the user's final choice.
    menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /closed/i }));
    expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Closed");
    expect(updatePostStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(post("p1", "MATCHED"));
      await Promise.resolve();
    });
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Closed"),
    );
    expect(updatePostStatusMock).toHaveBeenLastCalledWith("p1", "CLOSED");
  });

  it("copies the report link explicitly from the owner menu", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /copy link/i }));

    await waitFor(() => expect(copyReportLinkMock).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("my-posts-notice").textContent).toMatch(/link copied/i));
  });

  it("shows a selectable link instead of claiming a copy the platform refused", async () => {
    copyReportLinkMock.mockResolvedValue({
      status: "manual",
      url: "https://findback.example/posts/p1",
    });
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /copy link/i }));

    const field = await screen.findByLabelText("Report link");
    expect((field as HTMLInputElement).value).toBe("https://findback.example/posts/p1");
    expect((field as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("my-posts-copy-manual")).toBeNull();
  });

  it("reveals the next status on a horizontal swipe and runs it", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const swipe = screen.getAllByTestId("owner-status-swipe-surface")[0]!;
    fireEvent.pointerDown(swipe, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(swipe, { pointerId: 1, pointerType: "touch", clientX: 130, clientY: 100 });
    fireEvent.pointerUp(swipe, { pointerId: 1, pointerType: "touch", clientX: 130, clientY: 100 });

    fireEvent.click(screen.getByRole("button", { name: "Mark matched" }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalledWith("p1", "MATCHED"));
  });

  it("routes Recovered through the recovery sheet, never a bare status write", async () => {
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /recovered/i }));

    await waitFor(() => expect(recoverySheet.open).toBe(true));
    expect(recoverySheet.post).toMatchObject({ id: "p1", type: "LOST" });
    expect(updatePostStatusMock).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm recovery/i }));
    await waitFor(() =>
      expect(screen.getAllByTestId("owner-report-status")[0]!.textContent).toContain("Recovered"),
    );
    expect(updatePostStatusMock).not.toHaveBeenCalled();
  });

  it("does not persist a clean stale feed after a late confirmed recovery", async () => {
    const view = renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    // A recovery that confirms after the sheet was dismissed invalidates the
    // caches while this feed is still mounted and still holds the OPEN row.
    invalidateFeedCaches();
    view.unmount();

    fetchFeedMock.mockClear();
    renderMyPosts();
    // The stale mounted snapshot must not be saved as fresh: the next mount
    // has to refetch instead of restoring a clean OPEN row.
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
  });

  it("keeps the invalidation across a failed remount refresh", async () => {
    const first = renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    // A confirmed recovery invalidated the caches after the sheet closed.
    invalidateFeedCaches();
    first.unmount();

    fetchFeedMock.mockClear();
    fetchFeedMock.mockRejectedValueOnce(new Error("network down"));
    const second = renderMyPosts();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
    // The dirty snapshot was restored, but its refresh failed; the old OPEN
    // rows must not become a clean cache on the way out.
    await screen.findByText(/network problem/i);
    second.unmount();

    fetchFeedMock.mockReset();
    fetchFeedMock.mockResolvedValue({
      items: [post("p1"), post("p2")],
      nextCursor: null,
      total: 2,
    });
    renderMyPosts();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
  });

  it("discards a retained recovery target when the account changes", async () => {
    const view = renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(2));
    const menu = openFirstRowMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /recovered/i }));
    await waitFor(() => expect(recoverySheet.open).toBe(true));

    authState.user = { id: "u2", username: "bob" };
    view.rerender(
      <MemoryRouter initialEntries={["/my-reports"]}>
        <ReportDeletionFeedbackProvider><MyPosts /></ReportDeletionFeedbackProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(recoverySheet.open).toBe(false));
  });

  it("does not offer Recovered on a FOUND report", async () => {
    fetchFeedMock.mockResolvedValue({
      items: [post("p3", "OPEN", "FOUND")],
      nextCursor: null,
      total: 1,
    });
    renderMyPosts();
    await waitFor(() => expect(screen.getAllByTestId("owner-report-card")).toHaveLength(1));
    const menu = openFirstRowMenu();
    expect(within(menu).queryByRole("menuitemradio", { name: /recovered/i })).toBeNull();
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

  it("does not abandon the first scheduled delete when another row requests deletion", async () => {
    renderMyPosts();
    await screen.findAllByTestId("owner-report-card");
    vi.useFakeTimers();
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitem", { name: /delete report/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /manage report/i })[1]!);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /delete report/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10); });
    expect(deletePostMock.mock.calls).toEqual([["p1"]]);
    expect(screen.getByText("Report p2")).toBeTruthy();
  });

  it("sends a pending deletion exactly once on leaving, never again from the old timer", async () => {
    const view = renderMyPosts();
    await screen.findAllByTestId("owner-report-card");
    vi.useFakeTimers();
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitem", { name: /delete report/i }));
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10); });
    expect(deletePostMock.mock.calls).toEqual([["p1"]]);
  });

  it("does not send again on leaving while deletion is already in flight", async () => {
    let resolve!: () => void;
    deletePostMock.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    const view = renderMyPosts();
    await screen.findAllByTestId("owner-report-card");
    vi.useFakeTimers();
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitem", { name: /delete report/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10); });
    view.unmount();
    await act(async () => { resolve(); });
    expect(deletePostMock.mock.calls).toEqual([["p1"]]);
  });

  it("Undo immediately followed by unmount never sends the cancelled request", async () => {
    const view = renderMyPosts();
    await screen.findAllByTestId("owner-report-card");
    vi.useFakeTimers();
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitem", { name: /delete report/i }));
    act(() => {
      within(screen.getByTestId("my-posts-delete-undo")).getByRole("button", { name: "Undo" }).click();
      view.unmount();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10); });
    expect(deletePostMock).not.toHaveBeenCalled();
  });

  it("keeps a refused deletion visible after navigating away from My reports", async () => {
    deletePostMock.mockRejectedValue(new Error("connection lost"));
    render(<MemoryRouter initialEntries={["/my"]}>
      <ReportDeletionFeedbackProvider><Routes>
        <Route path="/my" element={<MyPosts />} />
        <Route path="/profile" element={<h1>Profile</h1>} />
      </Routes></ReportDeletionFeedbackProvider>
    </MemoryRouter>);
    await screen.findAllByTestId("owner-report-card");
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitem", { name: /delete report/i }));
    fireEvent.click(screen.getByRole("button", { name: /back to profile/i }));
    await screen.findByRole("heading", { name: "Profile" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/report not deleted/i);
    expect(deletePostMock.mock.calls).toEqual([["p1"]]);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes a changed report from a status-filtered list and its count, without a refetch", async () => {
    renderMyPosts();
    await screen.findAllByTestId("owner-report-card");
    fireEvent.click(screen.getByRole("radio", { name: "Open" }));
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ status: "OPEN" }), undefined));
    fireEvent.click(within(openFirstRowMenu()).getByRole("menuitemradio", { name: /matched/i }));
    await waitFor(() => expect(updatePostStatusMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Report p1")).toBeNull());
    expect(screen.getByText(/1 report ·/)).toBeTruthy();
    expect(screen.getByText("Report p2")).toBeTruthy();
    expect(fetchFeedMock).toHaveBeenCalledTimes(2);
  });
});
