// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    blockedActor: false,
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

/** The inbox list, scoped so the page's own links (settings gear) are out of scope. */
function inbox() {
  return screen.getByRole("list", { name: "Notifications" });
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

/**
 * O5 / CF-060 B1: the DB returns the notification row either way and projects
 * the caller-scoped, direction-free `blocked_actor` bit. The client carries it
 * and screens the row IN PLACE with the canonical shield — the same two-state
 * treatment the profile reports row and the detail report region already use:
 * the row's own content (including its link) sits inside the shield, and the
 * shield makes that content `inert` + `aria-hidden` while it is locked.
 */
describe("Notifications — blocked_actor (O5)", () => {
  it("screens a blocked actor's row with the canonical shield", async () => {
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const row = await screen.findByTestId("blocked-shield");
    expect(row.getAttribute("data-mode")).toBe("row");
    expect(row.getAttribute("data-locked")).toBe("true");

    // Direction-free copy: the bit never says who blocked whom.
    const warning = screen.getByTestId("blocked-shield-warning");
    expect(warning.textContent).toContain("Hidden by a block");
    expect(warning.textContent).not.toMatch(/\byou blocked\b/i);
    expect(warning.textContent).not.toMatch(/\bblocked you\b/i);

    // The hidden subtree is inert and hidden from assistive tech.
    const content = screen.getByTestId("blocked-shield-content");
    expect(content.getAttribute("inert")).not.toBeNull();
    expect(content.getAttribute("aria-hidden")).toBe("true");

    // The reveal control is a real button, a SIBLING of the hidden subtree.
    const reveal = screen.getByRole("button", { name: "Show content" });
    expect(reveal.tagName).toBe("BUTTON");
    expect(content.contains(reveal)).toBe(false);
    expect(reveal.closest("a")).toBeNull();
  });

  it("is not navigable while the row is locked", async () => {
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    await screen.findByTestId("blocked-shield");
    // The row's link is the SAME link it always was — it is only inside the
    // locked, inert wrapper, so it is not in the accessibility tree and not
    // reachable by pointer.
    expect(inbox().querySelector("a")).toBeTruthy();
    expect(within(inbox()).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("link", { name: /bob/i })).toBeNull();
    // Nothing navigated, and the row was not silently marked read.
    expect(screen.queryByTestId("location")).toBeNull();
    expect(markReadMock).not.toHaveBeenCalled();
  });

  it("keeps the locked row's link inside the shield's inert container", async () => {
    // The BEHAVIOURAL half of the locked state: the link is a descendant of
    // the container the shield makes inert, so a real browser takes it out of
    // the keyboard order and out of reach by pointer. jsdom implements
    // neither `inert` nor `visibility: hidden`, so the inert BEHAVIOUR
    // itself still owes a real WebView check — what is pinned here is where
    // the link lives.
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    await screen.findByTestId("blocked-shield");
    const content = screen.getByTestId("blocked-shield-content");
    const link = inbox().querySelector("a");
    expect(link).toBeTruthy();
    expect(content.contains(link)).toBe(true);
    expect(content.getAttribute("inert")).not.toBeNull();
    expect(content.getAttribute("aria-hidden")).toBe("true");

    // After the reveal the same container is no longer inert, so the link is
    // reachable again.
    fireEvent.click(screen.getByRole("button", { name: "Show content" }));
    const revealed = screen.getByTestId("blocked-shield-content");
    expect(revealed.getAttribute("inert")).toBeNull();
    expect(revealed.getAttribute("aria-hidden")).toBeNull();
    expect(revealed.contains(inbox().querySelector("a")!)).toBe(true);
  });

  it("never turns a gesture that starts on the reveal control into a swipe", async () => {
    // The row is a swipe-to-delete surface and the reveal control sits inside
    // it: a horizontal drag that starts on "Show content" must reveal, never
    // commit the swipe action (delete / mark-read).
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    const row = await screen.findByTestId("notification-row");
    const gesture = vi.fn();
    row.addEventListener("pointerdown", gesture);

    // A gesture that starts on the reveal control never reaches the row's
    // drag surface.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Show content" }));
    expect(gesture).not.toHaveBeenCalled();
    // ...and no swipe action was committed.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(markReadMock).not.toHaveBeenCalled();

    // The swipe still works everywhere else on the row.
    fireEvent.pointerDown(row);
    expect(gesture).toHaveBeenCalled();
  });

  it("becomes navigable again once the content is revealed", async () => {
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    fireEvent.click(await screen.findByRole("button", { name: "Show content" }));

    const content = screen.getByTestId("blocked-shield-content");
    expect(content.getAttribute("inert")).toBeNull();
    expect(content.getAttribute("aria-hidden")).toBeNull();

    // Reading is preserved: the same row link now works, exactly like the
    // profile reports row and the detail report region.
    const link = await screen.findByRole("link", { name: /bob.*lost wallet/i });
    expect(link.getAttribute("href")).toBe("/posts/p1#detail-activity");

    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/posts/p1"));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith(["n1"]));
  });

  it("does not name the actor while the row is shielded", async () => {
    fetchMock.mockResolvedValue([item({ blockedActor: true })]);
    renderNotifications();

    const trigger = await screen.findByRole("button", { name: /more actions/i });
    expect(trigger.getAttribute("aria-label")).not.toContain("bob");
  });

  it("leaves an unblocked row exactly as it was: a link that navigates", async () => {
    fetchMock.mockResolvedValue([item({ blockedActor: false })]);
    renderNotifications();

    const link = await screen.findByRole("link", { name: /bob.*lost wallet/i });
    expect(link.getAttribute("href")).toBe("/posts/p1#detail-activity");
    expect(screen.queryByTestId("blocked-shield")).toBeNull();

    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/posts/p1"));
    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith(["n1"]));
  });

  it("treats an absent blocked_actor as an unblocked row (older backend)", async () => {
    const legacy = item();
    delete (legacy as Record<string, unknown>).blockedActor;
    fetchMock.mockResolvedValue([legacy]);
    renderNotifications();

    const link = await screen.findByRole("link", { name: /bob.*lost wallet/i });
    expect(link.getAttribute("href")).toBe("/posts/p1#detail-activity");
    expect(screen.queryByTestId("blocked-shield")).toBeNull();
  });
});
