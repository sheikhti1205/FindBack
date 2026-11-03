// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostItem } from "@norfold/shared";

import { OwnerReportActionsProvider, OwnerReportMenu } from "./OwnerReportActions";

/**
 * The overflow menu of a My Reports row.
 *
 * The row uses the canonical `ActionMenu`, so the guarantees come from that
 * owner: a real menu, one anchored layer, arrow-key movement, Escape returning
 * focus to the trigger, and a destructive row separated from the rest. The
 * screen still owns every handler; the row only asks for them.
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

async function openMenu() {
  const trigger = screen.getByRole("button", { name: /manage report/i });
  trigger.focus();
  // Keyboard-open focuses the first enabled item, which is what the canonical
  // menu owner guarantees; the click path is covered separately.
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu", { name: /manage report/i });
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  return { trigger, menu };
}

afterEach(cleanup);

describe("the overflow menu", () => {
  it("opens from the trigger and shows the actions as menu items", async () => {
    renderMenu();

    const trigger = screen.getByRole("button", { name: /manage report/i });
    expect(["menu", "true"]).toContain(trigger.getAttribute("aria-haspopup"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: /manage report/i });
    expect(menu.getAttribute("aria-label")).toBeTruthy();
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0);
    // The owner-writable statuses stay one tap away, and the current one says so.
    expect(within(menu).getByRole("menuitem", { name: "Open (current)" })).toBeTruthy();
  });

  it.each(["OPEN", "RECOVERED", "CLOSED"] as const)("gives every menu child an allowed role for a %s report", async (status) => {
    renderMenu(handlers(), { ...post, status });
    const { menu } = await openMenu();

    for (const child of Array.from(menu.children)) {
      const role = child.getAttribute("role");
      expect(
        ["menuitem", "separator"].includes(role ?? ""),
        `a menu child carries a valid role (got ${role})`,
      ).toBe(true);
    }
  });

  it("closes on Escape and gives the focus back to the trigger", async () => {
    renderMenu();
    const { trigger } = await openMenu();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves the focus with the arrow keys", async () => {
    renderMenu();
    const { menu } = await openMenu();

    const items = within(menu).getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });

  it("runs an action and closes the menu", async () => {
    const value = renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /edit details/i }));

    expect(value.onEdit).toHaveBeenCalledWith(post);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("copies the link when the screen supplies the handler", async () => {
    const value = renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /copy link/i }));

    expect(value.onCopy).toHaveBeenCalledWith(post);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps the destructive delete in its own separated row", async () => {
    const value = renderMenu();
    const { menu } = await openMenu();

    const remove = within(menu).getByRole("menuitem", { name: /delete report/i });
    expect(remove.className).toMatch(/fb-menu-danger/);
    fireEvent.click(remove);
    expect(value.onDelete).toHaveBeenCalledWith(post);
  });

  it("offers the owner-writable statuses and marks the current one", async () => {
    const value = renderMenu();
    const { menu } = await openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Open (current)" })).toBeTruthy();
    // MATCHED and RECOVERED are relationship facts, never owner-set statuses.
    expect(within(menu).queryByRole("menuitem", { name: /^matched/i })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^recovered/i })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Closed" }));
    expect(value.onChangeStatus).toHaveBeenCalledWith(post, "CLOSED");
  });

  it("explains why a resolved report cannot be edited instead of offering it", async () => {
    renderMenu(handlers(), { ...post, status: "RECOVERED" });
    const { menu } = await openMenu();

    const edit = within(menu).getByRole("menuitem", { name: /closed reports can’t be edited/i });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows no controls at all outside a provider", () => {
    render(<OwnerReportMenu post={post} />);
    expect(screen.queryByRole("button", { name: /manage report/i })).toBeNull();
  });

  it("routes a MATCHED owner to handover/correction instead of an unlinked recovery or bare status write", async () => {
    const value = handlers({ onRecordRecovery: vi.fn(), onManageMatch: vi.fn() });
    const report = { ...post, status: "MATCHED" as const };
    renderMenu(value, report);
    const { menu } = await openMenu();

    const match = within(menu).getByRole("menuitem", { name: "Match and handover…" });
    expect(document.activeElement).toBe(match);
    expect(within(menu).queryByRole("menuitem", { name: "Record recovery…" })).toBeNull();

    // Status writes stay closed while a match is live. None of the
    // owner-writable statuses is the current one: the match owns it.
    for (const status of ["Open", "Closed"]) {
      const item = within(menu).getByRole("menuitem", { name: status });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(item);
    }
    expect(value.onChangeStatus).not.toHaveBeenCalled();

    fireEvent.click(match);
    expect(value.onManageMatch).toHaveBeenCalledWith(report);
    expect(value.onRecordRecovery).not.toHaveBeenCalled();
  });
});
