// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../services/notifications", () => ({
  fetchNotifications: fetchMock,
  markNotificationsRead: vi.fn(async () => 1),
  markNotificationsUnread: vi.fn(async () => 0),
  deleteNotifications: vi.fn(async () => 0),
  restoreNotifications: vi.fn(async () => 0),
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

function systemItem() {
  return item({
    id: "n2",
    type: "STATUS",
    actorId: null,
    actorUsername: null,
    postId: null,
    postTitle: null,
    preview: "Status changed",
  });
}

function renderNotifications() {
  return render(
    <MemoryRouter initialEntries={["/notifications"]}>
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/posts/:id" element={<div data-testid="post-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

describe("Notifications identity (W7)", () => {
  it("renders the canonical UserAvatar for the actor, seeded from the username", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();

    await screen.findByText("bob");
    const avatars = screen.getAllByTestId("user-avatar");
    expect(avatars).toHaveLength(1);
    expect(avatars[0]!.textContent).toBe("BO");
  });

  it("falls back to the generic glyph for system rows with no actor", async () => {
    fetchMock.mockResolvedValue([systemItem()]);
    renderNotifications();

    await screen.findByText("Status changed");
    const avatar = screen.getByTestId("user-avatar");
    expect(avatar.querySelector("svg")).toBeTruthy();
    expect(avatar.textContent).toBe("");
  });

  it("keeps row navigation and copy unchanged", async () => {
    fetchMock.mockResolvedValue([item(), systemItem()]);
    renderNotifications();

    await screen.findByText("bob");
    expect(screen.getByText(/liked your report/i)).toBeTruthy();
    const row = screen.getByRole("link", { name: /bob.*lost wallet/i });
    expect(row.getAttribute("href")).toBe("/posts/p1#detail-activity");
  });
});
