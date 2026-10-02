// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, deleteMock, restoreMock, signalMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  deleteMock: vi.fn(),
  restoreMock: vi.fn(),
  signalMock: vi.fn(),
}));

vi.mock("../services/notifications", () => ({
  fetchNotifications: fetchMock,
  markNotificationsRead: vi.fn(async () => 1),
  markNotificationsUnread: vi.fn(async () => 1),
  deleteNotifications: deleteMock,
  restoreNotifications: restoreMock,
}));
vi.mock("../services/notificationSignals", () => ({ signalInboxChanged: signalMock }));

import { Notifications, UNDO_WINDOW_MS, swipeActionFor } from "./Notifications";

function item() {
  return {
    id: "n1",
    type: "LIKE",
    preview: "Lost wallet",
    read: false,
    createdAt: new Date().toISOString(),
    actorId: "u2",
    actorUsername: "bob",
    postId: "p1",
    postTitle: "Lost wallet",
    commentId: null,
  };
}

function renderNotifications() {
  return render(
    <MemoryRouter initialEntries={["/notifications"]}>
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  deleteMock.mockReset();
  restoreMock.mockReset();
  signalMock.mockReset();
  deleteMock.mockResolvedValue(1);
  restoreMock.mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("swipeActionFor", () => {
  it("maps right to toggle-read, left to delete, and short drags to nothing", () => {
    expect(swipeActionFor(120)).toBe("toggle-read");
    expect(swipeActionFor(-120)).toBe("delete");
    expect(swipeActionFor(10)).toBeNull();
    expect(swipeActionFor(-10)).toBeNull();
  });
});

describe("inbox change signal", () => {
  it("emits a local-inbox signal after a successful delete", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(["n1"]));
    await waitFor(() => expect(signalMock).toHaveBeenCalled());
  });
});

describe("undo window", () => {
  it("auto-dismisses the undo banner after the 5-second window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/notification deleted/i)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    await waitFor(() => expect(screen.queryByText(/notification deleted/i)).toBeNull());
  });
});
