// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "../services/notifications";
import { consumeBackIntercept, resetBackInterceptors } from "./backNavigation";
import { resetModalLayers } from "../hooks/modalLayers";

const io = vi.hoisted(() => ({
  unread: vi.fn(), rows: vi.fn(), read: vi.fn(), unreadRows: vi.fn(), remove: vi.fn(), restore: vi.fn(),
  user: { id: "owner-a" } as { id: string } | null,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: io.user }) }));
vi.mock("../services/notifications", () => ({
  fetchUnreadCount: io.unread, fetchNotifications: io.rows, markNotificationsRead: io.read,
  markNotificationsUnread: io.unreadRows, deleteNotifications: io.remove, restoreNotifications: io.restore,
}));

import { TopUtilities } from "./TopUtilities";

function row(id: string, read = false, extras: Partial<NotificationItem> = {}): NotificationItem {
  return { id, type: "COMMENT", read, createdAt: "2026-10-31T10:00:00Z", actorId: `actor-${id}`,
    actorUsername: `reader-${id}`, preview: "I found something similar.", postId: "report-1",
    postTitle: "Blue backpack", commentId: `comment-${id}`, reactionKind: null, blockedActor: false, ...extras };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function RouteProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname + location.search + location.hash}</output>;
}
function tree(path = "/my", liveBadge = false) {
  return <MemoryRouter initialEntries={[path]}><TopUtilities liveBadge={liveBadge} /><RouteProbe /></MemoryRouter>;
}
async function openInbox() {
  const bell = screen.getByRole("button", { name: "Notifications" });
  act(() => bell.focus());
  fireEvent.click(bell);
  return screen.findByRole("dialog", { name: "Notifications" });
}
const previousWidth = window.innerWidth;
beforeEach(() => {
  window.innerWidth = 1000;
  io.user = { id: "owner-a" };
  for (const fn of [io.rows, io.unread, io.read, io.unreadRows, io.remove, io.restore]) fn.mockReset();
  io.rows.mockResolvedValue([row("1")]);
  io.unread.mockResolvedValue(3);
  io.read.mockResolvedValue(1);
  io.unreadRows.mockResolvedValue(1);
  io.remove.mockResolvedValue(1);
  io.restore.mockResolvedValue(1);
});
afterEach(() => { cleanup(); window.innerWidth = previousWidth; resetBackInterceptors(); resetModalLayers(); });

describe("notification utility quick view", () => {
  it.each([600, 1000])("opens recent activity at %spx without navigating or marking anything read", async width => {
    window.innerWidth = width;
    render(tree());
    const dialog = await openInbox();
    expect(await within(dialog).findByText("reader-1")).toBeTruthy();
    expect(screen.getByTestId("route").textContent).toBe("/my");
    expect(io.read).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("link", { name: "See all notifications" }).getAttribute("href")).toBe("/notifications");
  });

  it("keeps the phone bell a direct full-inbox link without mounting a quick inbox", () => {
    window.innerWidth = 320;
    render(tree());
    fireEvent.click(screen.getByRole("link", { name: "Notifications" }));
    expect(screen.getByTestId("route").textContent).toBe("/notifications");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(io.rows).not.toHaveBeenCalled();
  });

  it("does not mount a second inbox on the full notifications destination", () => {
    render(tree("/notifications"));
    expect(screen.getByRole("link", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(io.rows).not.toHaveBeenCalled();
  });

  it("shows eight recent rows and filters all fetched rows before taking the unread preview", async () => {
    io.rows.mockResolvedValue(Array.from({ length: 12 }, (_, index) => row(String(index + 1), index < 8)));
    render(tree());
    const dialog = await openInbox();
    await within(dialog).findByText("reader-1");
    expect(within(dialog).getAllByTestId("notification-row")).toHaveLength(8);
    expect(within(dialog).queryByText("reader-9")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Unread" }));
    await within(dialog).findByText("reader-9");
    expect(within(dialog).getAllByTestId("notification-row")).toHaveLength(4);
    expect(within(dialog).queryByText("reader-1")).toBeNull();
    expect(io.rows).toHaveBeenCalledTimes(1);
  });

  it("admits only the tapped read write before closing and following the exact comment route", async () => {
    const read = deferred<number>();
    io.read.mockReturnValueOnce(read.promise);
    render(tree());
    const dialog = await openInbox();
    fireEvent.click(await within(dialog).findByRole("link", { name: /reader-1.*Blue backpack/i }));
    expect(io.read).toHaveBeenCalledWith(["1"]);
    expect(screen.getByTestId("route").textContent).toBe("/posts/report-1?comment=comment-1#detail-comments");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => { read.resolve(1); });
  });

  it("closes the quick view before navigating to the full list", async () => {
    render(tree());
    const dialog = await openInbox();
    fireEvent.click(within(dialog).getByRole("link", { name: "See all notifications" }));
    expect(screen.getByTestId("route").textContent).toBe("/notifications");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(io.read).not.toHaveBeenCalled();
  });

  it("retries a failed quick inbox without replacing the parent route", async () => {
    io.rows.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce([row("retry")]);
    render(tree());
    const dialog = await openInbox();
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /try again/i }));
    expect(await within(dialog).findByText("reader-retry")).toBeTruthy();
    expect(screen.getByTestId("route").textContent).toBe("/my");
  });

  it("drops old-account rows and refuses a late refresh after replacement while open", async () => {
    const old = deferred<NotificationItem[]>();
    io.rows.mockResolvedValueOnce([row("old")]).mockReturnValueOnce(old.promise).mockResolvedValueOnce([row("new")]);
    const page = render(tree());
    await openInbox();
    await screen.findByText("reader-old");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(io.rows).toHaveBeenCalledTimes(2));
    io.user = { id: "owner-b" };
    page.rerender(tree());
    expect(screen.queryByText("reader-old")).toBeNull();
    // Re-keying may safely close the old layer; reopening must fetch B only.
    if (!screen.queryByRole("dialog")) await openInbox();
    await screen.findByText("reader-new");
    await act(async () => { old.resolve([row("late-old")]); });
    expect(screen.queryByText("reader-late-old")).toBeNull();
    expect(screen.getByText("reader-new")).toBeTruthy();
  });

  it("keeps blocked actor labels private in a nested action menu and Back dismisses one layer", async () => {
    io.rows.mockResolvedValue([row("secret", false, { blockedActor: true })]);
    render(tree());
    const dialog = await openInbox();
    const trigger = await within(dialog).findByRole("button", { name: /more actions for a hidden notification/i });
    expect(within(dialog).queryByRole("link", { name: /reader-secret/i })).toBeNull();
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-label")).not.toContain("reader-secret");
    act(() => { expect(consumeBackIntercept()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Notifications" })));
  });

  it("never publishes an old-account unread badge after account replacement", async () => {
    const old = deferred<number>();
    io.unread.mockReturnValueOnce(old.promise).mockResolvedValueOnce(2);
    const page = render(tree("/my", true));
    await waitFor(() => expect(io.unread).toHaveBeenCalledTimes(1));
    io.user = { id: "owner-b" };
    page.rerender(tree("/my", true));
    expect((await screen.findByTestId("notifications-unread-badge")).textContent).toBe("2");
    await act(async () => { old.resolve(9); });
    expect(screen.getByTestId("notifications-unread-badge").textContent).toBe("2");
  });
});
