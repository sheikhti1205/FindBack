// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, markReadMock, markUnreadMock, deleteMock, restoreMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  markReadMock: vi.fn(),
  markUnreadMock: vi.fn(),
  deleteMock: vi.fn(),
  restoreMock: vi.fn(),
}));
const { authState } = vi.hoisted(() => ({ authState: { user: { id: "owner-a" } as { id: string } | null } }));
vi.mock("../auth", () => ({ useAuth: () => authState }));

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

function notificationsTree() {
  return (
    <MemoryRouter initialEntries={["/notifications"]}>
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/posts/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderNotifications() { return render(notificationsTree()); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * Packet `08` §17: the row's actions live behind one overflow trigger, so a
 * test reaches them the way a user without a swipe does.
 */
async function openRowActions(actor = "bob") {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`more actions for ${actor}`, "i") }));
  return screen.findByRole("menu");
}

beforeEach(() => {
  authState.user = { id: "owner-a" };
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
  it("renders an actorless moderation outcome as a review update with server consequence copy", async () => {
    fetchMock.mockResolvedValue([item({ type: "MODERATION", actorId: null, actorUsername: null,
      postId: null, postTitle: null, preview: "Your account cannot publish new reports right now." })]);
    renderNotifications();
    expect(await screen.findByText("Your account cannot publish new reports right now.")).toBeTruthy();
    expect(screen.getByText("review update")).toBeTruthy();
    expect(screen.getByText("FindBack")).toBeTruthy();
    expect(screen.queryByText("MODERATION")).toBeNull();
    expect(screen.queryByRole("link", { name: /your report/i })).toBeNull();
  });
  it("drops old-account rows and refuses a late old-account response", async () => {
    const old = deferred<ReturnType<typeof item>[]>();
    fetchMock.mockResolvedValueOnce([item({ actorUsername: "account A actor" })])
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([item({ actorUsername: "account B actor" })]);
    const page = renderNotifications();
    await screen.findByText("account A actor");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    authState.user = { id: "owner-b" };
    page.rerender(notificationsTree());
    expect(screen.queryByText("account A actor")).toBeNull();
    await screen.findByText("account B actor");
    await act(async () => { old.resolve([item({ actorUsername: "late account A actor" })]); });
    expect(screen.getByText("account B actor")).toBeTruthy();
    expect(screen.queryByText("late account A actor")).toBeNull();
  });

  it("does not restore old inbox rows when a deletion fails after switching views", async () => {
    const deletion = deferred<number>();
    deleteMock.mockReturnValueOnce(deletion.promise);
    fetchMock.mockResolvedValueOnce([item()]).mockResolvedValueOnce([item({ actorUsername: "deleted actor" })]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Deleted" }));
    // StateSwap keeps the outgoing inbox alive briefly for its exit motion.
    // Finish that transition before checking whether the late failure revives it.
    await waitFor(() => expect(screen.queryByText("bob")).toBeNull());
    await act(async () => { deletion.reject(new Error("network down")); });
    expect(await screen.findByText("deleted actor")).toBeTruthy();
    expect(screen.queryByText("bob")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not send an old-account Undo after the pending deletion settles", async () => {
    const deletion = deferred<number>();
    deleteMock.mockReturnValueOnce(deletion.promise);
    fetchMock.mockResolvedValueOnce([item()]).mockResolvedValueOnce([item({ actorUsername: "account B actor" })]);
    const page = renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    authState.user = { id: "owner-b" };
    page.rerender(notificationsTree());
    await screen.findByText("account B actor");
    await act(async () => { deletion.resolve(1); });
    expect(restoreMock).not.toHaveBeenCalled();
    expect(screen.getByText("account B actor")).toBeTruthy();
  });

  it("does not restore a notification when the original delete was refused", async () => {
    const deletion = deferred<number>();
    deleteMock.mockReturnValueOnce(deletion.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await act(async () => { deletion.reject(new Error("network down")); });
    expect(restoreMock).not.toHaveBeenCalled();
    expect(await screen.findByText("bob")).toBeTruthy();
  });

  it("keeps a later unread choice when the preceding read write fails", async () => {
    const reading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledTimes(1));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark unread/i }));
    expect(screen.getByLabelText(/unread/i)).toBeTruthy();
    // A later choice must reach the server after the earlier choice settles.
    expect(markUnreadMock).not.toHaveBeenCalled();
    await act(async () => { reading.reject(new Error("network down")); });
    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(/unread/i)).toBeTruthy();
  });

  it("rolls two failed read choices back to the last confirmed read state", async () => {
    const reading = deferred<number>();
    const unreading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    markUnreadMock.mockReturnValueOnce(unreading.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledTimes(1));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark unread/i }));
    await act(async () => { reading.reject(new Error("network down")); });
    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledTimes(1));
    await act(async () => { unreading.reject(new Error("network still down")); });
    expect(screen.getByLabelText(/unread/i)).toBeTruthy();
  });

  it("rolls a refused unread choice back to the preceding successful read", async () => {
    const reading = deferred<number>();
    const unreading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    markUnreadMock.mockReturnValueOnce(unreading.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark unread/i }));
    await act(async () => { reading.resolve(1); });
    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledTimes(1));
    await act(async () => { unreading.reject(new Error("network down")); });
    expect(screen.queryByLabelText(/unread/i)).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
  });

  it("does not issue queued old-account mutations after account replacement", async () => {
    const reading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    fetchMock.mockResolvedValue([item()]);
    const page = renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    expect(deleteMock).not.toHaveBeenCalled();
    authState.user = { id: "owner-b" };
    fetchMock.mockResolvedValue([item({ actorUsername: "account B actor" })]);
    page.rerender(notificationsTree());
    await screen.findByText("account B actor");
    await act(async () => { reading.resolve(1); });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByText("account B actor")).toBeTruthy();
    expect(screen.queryByText(/notification deleted/i)).toBeNull();
  });

  it("keeps Undo failure feedback visible after the server refresh", async () => {
    restoreMock.mockRejectedValue(new Error("network down"));
    fetchMock.mockResolvedValueOnce([item()]).mockResolvedValueOnce([]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(await screen.findByText(/no notifications/i)).toBeTruthy();
  });

  it("does not resurrect another deleted row when a bulk read write fails", async () => {
    const reading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    fetchMock.mockResolvedValue([item(), item({ id: "n2", actorUsername: "cara" })]);
    renderNotifications();
    fireEvent.click(await screen.findByRole("button", { name: /mark all read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledTimes(1));
    await openRowActions("cara");
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByText("cara")).toBeNull());
    await act(async () => { reading.reject(new Error("network down")); });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(["n2"]));
    expect(screen.queryByText("cara")).toBeNull();
    expect(screen.getByText("bob")).toBeTruthy();
  });

  it("rolls back only the refused deletion when another deletion succeeds", async () => {
    const deletion = deferred<number>();
    deleteMock.mockReturnValueOnce(deletion.promise).mockResolvedValueOnce(1);
    fetchMock.mockResolvedValue([item(), item({ id: "n2", actorUsername: "cara" })]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    await openRowActions("cara");
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(screen.queryByText("cara")).toBeNull());
    await act(async () => { deletion.reject(new Error("network down")); });
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    // A retry can clear the error surface; the error must not hide the inbox.
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.queryByText("cara")).toBeNull();
  });

  it("waits for pending writes before refreshing server state on focus", async () => {
    const reading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    fetchMock.mockResolvedValueOnce([item()]).mockResolvedValue([item({ read: true })]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("focus"));
    // Otherwise the pre-write server snapshot can overwrite optimism.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { reading.resolve(1); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText(/unread/i)).toBeNull();
  });

  it("retains a requested refresh when another optimistic choice joins the write queue", async () => {
    const reading = deferred<number>();
    markReadMock.mockReturnValueOnce(reading.promise);
    fetchMock.mockResolvedValueOnce([item()]).mockResolvedValue([item({ actorUsername: "fresh actor" })]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    fireEvent(window, new Event("focus"));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark unread/i }));
    await act(async () => { reading.resolve(1); });
    await waitFor(() => expect(markUnreadMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("fresh actor")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a refresh response overtaken by a read mutation instead of losing the refresh", async () => {
    const stale = deferred<ReturnType<typeof item>[]>();
    fetchMock.mockResolvedValueOnce([item()]).mockReturnValueOnce(stale.promise)
      .mockResolvedValue([item({ read: true, actorUsername: "fresh actor" })]);
    renderNotifications();
    await screen.findByText("bob");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark read/i }));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledTimes(1));
    await act(async () => { stale.resolve([item({ actorUsername: "stale actor" })]); });
    expect(await screen.findByText("fresh actor")).toBeTruthy();
    expect(screen.queryByText("stale actor")).toBeNull();
  });

  it("does not publish a slower inbox request over the deleted view", async () => {
    const inbox = deferred<ReturnType<typeof item>[]>();
    fetchMock.mockReturnValueOnce(inbox.promise).mockResolvedValueOnce([item({ actorUsername: "deleted actor" })]);
    renderNotifications();
    fireEvent.click(screen.getByRole("button", { name: "Deleted" }));
    await screen.findByText("deleted actor");
    await act(async () => { inbox.resolve([item({ actorUsername: "old inbox actor" })]); });
    expect(screen.getByText("deleted actor")).toBeTruthy();
    expect(screen.queryByText("old inbox actor")).toBeNull();
  });

  it("does not replace a successful deleted view with an old inbox failure", async () => {
    const inbox = deferred<ReturnType<typeof item>[]>();
    fetchMock.mockReturnValueOnce(inbox.promise).mockResolvedValueOnce([item({ actorUsername: "deleted actor" })]);
    renderNotifications();
    fireEvent.click(screen.getByRole("button", { name: "Deleted" }));
    await screen.findByText("deleted actor");
    await act(async () => { inbox.reject(new Error("network down")); });
    expect(screen.getByText("deleted actor")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits for deletion to settle before sending an early Undo restore", async () => {
    const deletion = deferred<number>();
    deleteMock.mockReturnValueOnce(deletion.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    // Otherwise restore can commit first and the late delete wins on server.
    expect(restoreMock).not.toHaveBeenCalled();
    await act(async () => { deletion.resolve(1); });
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith(["n1"]));
    expect(await screen.findByText("bob")).toBeTruthy();
  });

  it("does not reload inbox content into Deleted when an Undo settles late", async () => {
    const restore = deferred<number>();
    restoreMock.mockReturnValueOnce(restore.promise);
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValue([item({ actorUsername: "deleted actor" })]);
    fireEvent.click(screen.getByRole("button", { name: "Deleted" }));
    fetchMock.mockImplementation(async ({ deleted }: { deleted: boolean }) => deleted
      ? [item({ actorUsername: "deleted actor" })]
      : [item({ actorUsername: "wrong inbox actor" })]);
    await act(async () => { restore.resolve(1); });
    expect(await screen.findByText("deleted actor")).toBeTruthy();
    expect(screen.queryByText("wrong inbox actor")).toBeNull();
  });

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

    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^delete$/i }));
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

    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /mark unread/i }));
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

    await openRowActions();
    fireEvent.click(screen.getByRole("menuitem", { name: /^restore$/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith(["n1"]));
  });

  it("keeps the row free of a permanent action bar and drives the menu by keyboard", async () => {
    fetchMock.mockResolvedValue([item()]);
    renderNotifications();
    await screen.findByText("bob");

    // §17: no permanent bottom bar — nothing to delete/mark until the menu opens.
    expect(screen.queryByRole("menuitem", { name: /^delete$/i })).toBeNull();
    const trigger = screen.getByRole("button", { name: /more actions for bob/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.className).toMatch(/min-h-\[44px\]/);
    expect(trigger.className).toMatch(/min-w-\[44px\]/);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = await screen.findByRole("menu");
    const mark = within(menu).getByRole("menuitem", { name: /mark read/i });
    const del = within(menu).getByRole("menuitem", { name: /^delete$/i });
    // Focus enters the menu, arrows rove, Escape leaves and hands focus back.
    expect(document.activeElement).toBe(mark);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(del);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
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
