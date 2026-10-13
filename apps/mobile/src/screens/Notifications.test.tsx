// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, markReadMock, markUnreadMock, deleteMock, restoreMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  markReadMock: vi.fn(),
  markUnreadMock: vi.fn(),
  deleteMock: vi.fn(),
  restoreMock: vi.fn(),
}));

vi.mock("../services/notifications", () => ({
  fetchNotifications: fetchMock,
  markNotificationsRead: markReadMock,
  markNotificationsUnread: markUnreadMock,
  deleteNotifications: deleteMock,
  restoreNotifications: restoreMock,
}));

import { Notifications, typeLabel } from "./Notifications";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    type: "LIKE",
    preview: "Lost wallet",
    read: false,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    actorId: "u2",
    actorUsername: "bob",
    postId: "p1",
    postTitle: "Lost wallet",
    commentId: null,
    ...overrides,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderNotifications() {
  return render(
    <MemoryRouter initialEntries={["/notifications"]}>
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/posts/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  markReadMock.mockReset();
  markUnreadMock.mockReset();
  deleteMock.mockReset();
  restoreMock.mockReset();
  markReadMock.mockResolvedValue(1);
  markUnreadMock.mockResolvedValue(1);
  deleteMock.mockResolvedValue(1);
  restoreMock.mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
});

describe("Notifications inbox", () => {
  it("lists actor, type, post title, preview and time", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    expect(await screen.findByText("bob")).toBeTruthy();
    expect(screen.getByText(/liked your report/i)).toBeTruthy();
    expect(screen.getByText("Lost wallet")).toBeTruthy();
    expect(screen.getByText(/5m ago/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith({ deleted: false });
  });

  it("styles unread items without auto-marking them read on open", async () => {
    fetchMock.mockResolvedValue([item({ read: false })]);
    renderNotifications();

    expect(await screen.findByLabelText(/unread/i)).toBeTruthy();
    expect(markReadMock).not.toHaveBeenCalled();
  });

  it("marks just the tapped item read and navigates", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("link", { name: /bob.*lost wallet/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith(["n1"]));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/posts/p1"));
  });

  it("clears the whole inbox with Mark all read", async () => {
    fetchMock.mockResolvedValue([item({ id: "n1" }), item({ id: "n2", actorUsername: "cara" })]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: /mark all read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith());
    await waitFor(() => expect(screen.queryByLabelText(/unread/i)).toBeNull());
  });

  it("sends the gear to notification settings instead of inline controls", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    await screen.findByText("bob");
    const gear = screen.getByRole("link", { name: /notification settings/i });
    expect(gear.getAttribute("href")).toBe("/settings/notifications");
    expect(screen.queryByRole("switch", { name: /push notifications/i })).toBeNull();
  });

  it("deletes an item, then restores it from the Undo banner", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(["n1"]));
    expect(await screen.findByText(/notification deleted/i)).toBeTruthy();

    fetchMock.mockResolvedValue([item()]);
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith(["n1"]));
    expect(await screen.findByText("bob")).toBeTruthy();
  });

  it("marks a read item unread", async () => {
    fetchMock.mockResolvedValue([item({ read: true })]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: /mark unread/i }));
    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledWith(["n1"]));
    expect(await screen.findByLabelText(/unread/i)).toBeTruthy();
  });

  it("shows the soft-deleted view and restores from it", async () => {
    fetchMock.mockResolvedValueOnce([item()]);
    renderNotifications();
    await screen.findByText("bob");

    fetchMock.mockResolvedValueOnce([item({ read: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Deleted" }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith({ deleted: true }));

    fireEvent.click(await screen.findByRole("button", { name: /restore/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith(["n1"]));
  });

  it("keeps a truthful empty state when the inbox is empty", async () => {
    fetchMock.mockResolvedValue([]);
    renderNotifications();

    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText(/no notifications/i)).toBeTruthy();
    // FBX-035 reactions copy: the empty state names reactions, not likes.
    expect(screen.getByText(/Reactions, comments, and mentions on your reports/i)).toBeTruthy();
    expect(screen.queryByText(/Likes, comments/i)).toBeNull();
    expect(markReadMock).not.toHaveBeenCalled();
  });

  it("retries after a load failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    renderNotifications();

    expect(await screen.findByRole("alert")).toBeTruthy();
    fetchMock.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no notifications/i)).toBeTruthy();
  });

  it("refetches when the window regains focus", async () => {
    fetchMock.mockResolvedValue([]);
    renderNotifications();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("typeLabel fail-safe", () => {
  it("labels UNKNOWN generically and never blanks a future kind", () => {
    expect(typeLabel("UNKNOWN")).toBe("sent you an update");
    expect(typeLabel("FUTURE_KIND" as unknown as never)).toBe("sent you an update");
  });
});

describe("Notifications REACTION kind (W1-A FBX-009)", () => {
  it("labels a REACTION row as a reaction and routes it to activity", async () => {
    fetchMock.mockResolvedValue([item({ id: "n7", type: "REACTION", preview: "Lost wallet" })]);
    renderNotifications();

    expect(await screen.findByText(/reacted to your report/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /bob.*reacted to your report/i });
    expect(link.getAttribute("href")).toBe("/posts/p1#detail-activity");
  });

  it("renders the canonical kind on a REACTION row carrying reactionKind", async () => {
    fetchMock.mockResolvedValue([item({ id: "n8", type: "REACTION", reactionKind: "LOVE" })]);
    renderNotifications();

    expect(await screen.findByText(/reacted to your report with Love/i)).toBeTruthy();
  });

  it("renders an UNKNOWN row with generic copy and a generic route (fail-safe)", async () => {
    fetchMock.mockResolvedValue([item({ id: "n9", type: "UNKNOWN" })]);
    renderNotifications();

    expect(await screen.findByText(/sent you an update/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /bob.*sent you an update/i });
    expect(link.getAttribute("href")).toBe("/posts/p1");
  });
});
