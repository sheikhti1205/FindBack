// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostItem } from "@findback/shared";

import { OwnerReportActionsProvider, OwnerReportMenu } from "./OwnerReportActions";

/**
 * The overflow menu of a My Reports row.
 *
 * Every action must be reachable by tap AND by keyboard: the menu is a real
 * menu with menu items, Escape closes it, the arrow keys move between the
 * items and the focus returns to the trigger when it closes. Swipe is never
 * the only route to an action.
 */

const post: PostItem = {
  id: "p1",
  userId: "u1",
  author: {
    id: "u1",
    username: "alice",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  type: "LOST",
  status: "OPEN",
  title: "Scientific calculator",
  description: "A black scientific calculator lost near the science faculty.",
  category: "Electronics",
  eventDate: "2026-09-29",
  latitude: 23.81,
  longitude: 90.41,
  locationLabel: "Dhaka",
  youtubeUrl: null,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 0,
  attachments: [],
};

function handlers(overrides: Partial<Parameters<typeof OwnerReportActionsProvider>[0]["value"]> = {}) {
  return {
    onChangeStatus: vi.fn(),
    onEdit: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

function renderMenu(value = handlers(), report = post) {
  render(
    <OwnerReportActionsProvider value={value}>
      <OwnerReportMenu post={report} />
    </OwnerReportActionsProvider>,
  );
  return value;
}

afterEach(cleanup);

describe("the overflow menu", () => {
  it("opens from the trigger and shows the actions as menu items", () => {
    renderMenu();

    const trigger = screen.getByRole("button", { name: /manage report/i });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-label")).toBeTruthy();
    // The status entries are radio items (one is current); the actions are
    // plain menu items.
    expect(screen.getAllByRole("menuitemradio").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
  });

  it.each(["OPEN", "RECOVERED", "CLOSED"] as const)("gives every menu child an allowed role for a %s report", (status) => {
    renderMenu(handlers(), { ...post, status });
    fireEvent.click(screen.getByRole("button", { name: /manage report/i }));

    const menu = screen.getByRole("menu");
    for (const child of Array.from(menu.children)) {
      const role = child.getAttribute("role");
      expect(
        ["menuitem", "menuitemradio", "presentation", "separator", "group"].includes(role ?? ""),
        `a menu child carries a valid role (got ${role})`,
      ).toBe(true);
    }
  });

  it("closes on Escape and gives the focus back to the trigger", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: /manage report/i });
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves the focus with the arrow keys, Home and End", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /manage report/i }));

    const menu = screen.getByRole("menu");
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]'),
    );
    expect(items.length).toBeGreaterThan(2);

    // The first item has the focus when the menu opens.
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("runs an action and closes the menu", () => {
    const value = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /manage report/i }));

    fireEvent.click(screen.getByRole("menuitem", { name: /edit details/i }));

    expect(value.onEdit).toHaveBeenCalledWith(post);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("copies the link when the screen supplies the handler", () => {
    const value = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /manage report/i }));

    fireEvent.click(screen.getByRole("menuitem", { name: /copy link/i }));

    expect(value.onCopy).toHaveBeenCalledWith(post);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows no controls at all outside a provider", () => {
    render(<OwnerReportMenu post={post} />);
    expect(screen.queryByRole("button", { name: /manage report/i })).toBeNull();
  });

  it("routes a MATCHED owner to handover/correction instead of an unlinked recovery or bare status write", () => {
    const value = handlers({ onRecordRecovery: vi.fn(), onManageMatch: vi.fn() });
    const report = { ...post, status: "MATCHED" as const };
    renderMenu(value, report);
    fireEvent.click(screen.getByRole("button", { name: /manage report/i }));
    const match = screen.getByRole("menuitem", { name: "Match and handover…" });
    expect(document.activeElement).toBe(match);
    expect(screen.queryByRole("menuitem", { name: "Record recovery…" })).toBeNull();
    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(radio);
    }
    expect(value.onChangeStatus).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
    expect(document.activeElement).toBe(match);
    fireEvent.click(match);
    expect(value.onManageMatch).toHaveBeenCalledWith(report);
    expect(value.onRecordRecovery).not.toHaveBeenCalled();
  });
});
