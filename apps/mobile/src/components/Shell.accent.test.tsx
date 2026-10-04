// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { unreadMock } = vi.hoisted(() => ({ unreadMock: vi.fn() }));

vi.mock("../services/notifications", () => ({ fetchUnreadCount: unreadMock }));

import { Shell } from "./Shell";

function renderShell(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<p>Home screen</p>} />
          <Route path="/my" element={<p>My Reports screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  unreadMock.mockReset();
});

describe("Shell accent consumers", () => {
  it("paints the selected link and active pill with primary tokens", () => {
    unreadMock.mockResolvedValue(0);
    renderShell("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(home.className).toContain("text-on-primary-container");
    const pill = nav.querySelector(".fb-nav-active-bg");
    expect(pill).toBeTruthy();
    expect(pill!.className).toContain("bg-primary-container");
  });

  it("leaves unselected links on the neutral variant tone", () => {
    unreadMock.mockResolvedValue(0);
    renderShell("/my");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home.hasAttribute("aria-current")).toBe(false);
    expect(home.className).toContain("text-on-surface-variant");
    expect(home.className).not.toContain("text-on-primary-container");
  });

  it("paints the create action with primary bg/on-primary", () => {
    unreadMock.mockResolvedValue(0);
    renderShell();
    const create = within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
      "link",
      { name: "Create report" },
    );
    expect(create.className).toContain("bg-primary");
    expect(create.className).toContain("text-on-primary");
  });

  it("keeps the unread badge on the semantic error color", async () => {
    unreadMock.mockResolvedValue(3);
    renderShell();
    const badge = await screen.findByTestId("notifications-unread-badge");
    expect(badge.className).toContain("bg-error");
    expect(badge.className).not.toContain("bg-primary");
  });
});
