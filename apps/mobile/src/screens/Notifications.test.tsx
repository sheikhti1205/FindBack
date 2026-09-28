// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, markReadMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  markReadMock: vi.fn(),
}));

vi.mock("../services/notifications", () => ({
  fetchNotifications: fetchMock,
  markNotificationsRead: markReadMock,
}));

import { Notifications } from "./Notifications";

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
  markReadMock.mockResolvedValue(0);
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
  });

  it("styles unread items and marks them read on view", async () => {
    let resolveMark!: (value: number) => void;
    markReadMock.mockImplementation(() => new Promise<number>((r) => { resolveMark = r; }));
    fetchMock.mockResolvedValue([
      item({ id: "n1", read: false }),
      item({ id: "n2", type: "COMMENT", read: true, actorUsername: "cara" }),
    ]);
    renderNotifications();

    // The fresh unread row is styled unread before the mark-read lands.
    expect(await screen.findByLabelText(/unread/i)).toBeTruthy();
    await waitFor(() => expect(markReadMock).toHaveBeenCalled());
    resolveMark(1);
    await waitFor(() => expect(screen.queryByLabelText(/unread/i)).toBeNull());
  });

  it("navigates to the post on tap", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("link", { name: /bob.*lost wallet/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/posts/p1"));
  });

  it("keeps a truthful empty state when the inbox is empty", async () => {
    fetchMock.mockResolvedValue([]);
    renderNotifications();

    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText(/no notifications/i)).toBeTruthy();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
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
