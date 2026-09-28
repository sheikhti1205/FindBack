// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { unreadMock } = vi.hoisted(() => ({ unreadMock: vi.fn() }));

vi.mock("../services/notifications", () => ({ fetchUnreadCount: unreadMock }));

import { Shell } from "./Shell";

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<p>Home screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  unreadMock.mockReset();
});

describe("Shell notifications badge", () => {
  it("shows the unread count on the bell without renaming the link", async () => {
    unreadMock.mockResolvedValue(3);
    renderShell();

    const badge = await screen.findByTestId("notifications-unread-badge");
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Notifications" })).toBeTruthy();
  });

  it("caps a large count and hides the badge at zero or on failure", async () => {
    unreadMock.mockResolvedValue(120);
    renderShell();
    expect(await screen.findByTestId("notifications-unread-badge")).toHaveProperty("textContent", "99+");
    cleanup();

    unreadMock.mockReset();
    unreadMock.mockResolvedValue(0);
    renderShell();
    await waitFor(() => expect(unreadMock).toHaveBeenCalled());
    expect(screen.queryByTestId("notifications-unread-badge")).toBeNull();
    cleanup();

    unreadMock.mockReset();
    unreadMock.mockRejectedValue(new Error("offline"));
    renderShell();
    await waitFor(() => expect(unreadMock).toHaveBeenCalled());
    expect(screen.queryByTestId("notifications-unread-badge")).toBeNull();
  });
});
