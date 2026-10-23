// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostItem, PublicProfile as PublicProfileShape } from "@findback/shared";

const { fetchPublicProfileMock, fetchFeedMock, authState, submitReport } = vi.hoisted(() => ({
  fetchPublicProfileMock: vi.fn(),
  fetchFeedMock: vi.fn(),
  authState: { user: { id: "reader" } as { id: string } | null },
  submitReport: vi.fn(),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../services/moderation", async (original) => ({
  ...await original<typeof import("../services/moderation")>(), submitReport,
}));

vi.mock("../services/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/profile")>();
  return { ...actual, fetchPublicProfile: fetchPublicProfileMock };
});
vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));

import { PublicProfile } from "./PublicProfile";

const profile: PublicProfileShape = {
  id: "u2",
  username: "owner",
  emailVerified: true,
  phoneVerified: true,
  avatarUrl: null,
  displayName: "Owner Name",
  bio: "I return lost things",
  locationLabel: "Dhaka",
  createdAt: "2026-01-05T00:00:00.000Z",
};

const post: PostItem = {
  id: "p1",
  userId: "u2",
  author: profile,
  type: "FOUND",
  title: "Found a wallet",
  description: "Brown leather wallet near the park.",
  category: "Bags & Wallets",
  status: "OPEN",
  eventDate: "2026-01-02",
  latitude: null,
  longitude: null,
  locationLabel: "Dhaka",
  youtubeUrl: null,
  attachments: [],
  likeCount: 0,
  dislikeCount: 0,
  ratingAvg: null,
  ratingCount: 0,
  commentCount: 0,
  createdAt: "2026-01-05T00:00:00.000Z",
  updatedAt: "2026-01-05T00:00:00.000Z",
};

function renderRoute(username = "owner") {
  return render(
    <MemoryRouter initialEntries={[`/u/${username}`]}>
      <Routes>
        <Route path="/u/:username" element={<PublicProfile />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: "reader" };
  submitReport.mockResolvedValue({ reportId: "receipt" });
  fetchPublicProfileMock.mockResolvedValue(profile);
  fetchFeedMock.mockResolvedValue({ items: [post], nextCursor: null, total: 1 });
});

describe("PublicProfile", () => {
  it("reports the loaded user through the profile overflow and canonical sheet", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "More profile actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Report user" }));
    fireEvent.click(screen.getByRole("radio", { name: /harassment/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await screen.findByTestId("report-receipt");
    expect(submitReport).toHaveBeenCalledWith({ targetType: "USER", targetId: "u2", reason: "HARASSMENT", detail: null });
  });

  it("does not offer profile safety actions for self or guests", async () => {
    authState.user = null;
    const view = renderRoute();
    await screen.findByText("Owner Name");
    expect(screen.queryByRole("button", { name: "More profile actions" })).toBeNull();
    view.unmount();
    authState.user = { id: "u2" };
    renderRoute();
    await screen.findByText("Owner Name");
    expect(screen.queryByRole("button", { name: "More profile actions" })).toBeNull();
  });
  it("loads the profile by the route handle", async () => {
    renderRoute("owner");
    await waitFor(() => expect(fetchPublicProfileMock).toHaveBeenCalledWith("owner"));
  });

  it("shows the public identity: display name, @username, bio, location, join date", async () => {
    renderRoute();
    expect(await screen.findByText("Owner Name")).toBeTruthy();
    expect(screen.getByText("@owner")).toBeTruthy();
    expect(screen.getByText("I return lost things")).toBeTruthy();
    expect(screen.getByText("Dhaka")).toBeTruthy();
    expect(screen.getByText(/joined/i)).toBeTruthy();
  });

  it("shows verification badges for the flags the profile reports", async () => {
    renderRoute();
    expect(await screen.findByText("Email verified")).toBeTruthy();
    expect(screen.getByText("Phone verified")).toBeTruthy();
  });

  it("renders the canonical avatar fallback and never a broken image", async () => {
    renderRoute();
    await screen.findByText("Owner Name");
    expect(screen.getByText("OW")).toBeTruthy();
  });

  it("strips email and phone from the public surface", async () => {
    renderRoute();
    await screen.findByText("Owner Name");
    expect(screen.queryByText(/@example\.com/)).toBeNull();
    expect(screen.queryByText("+8801812345678")).toBeNull();
  });

  it("links that user's public reports through the existing feed API", async () => {
    renderRoute();
    expect(await screen.findByText("Found a wallet")).toBeTruthy();
    expect(fetchFeedMock).toHaveBeenCalledWith({ userId: "u2" });
    expect(screen.getByRole("link", { name: "Found a wallet" }).getAttribute("href")).toBe(
      "/posts/p1",
    );
  });

  it("still renders the profile when the reports feed is unavailable", async () => {
    fetchFeedMock.mockRejectedValueOnce(new Error("feed down"));
    renderRoute();
    expect(await screen.findByText("Owner Name")).toBeTruthy();
    expect(screen.queryByText("Found a wallet")).toBeNull();
  });

  it("shows a human not-found message when the lookup fails", async () => {
    fetchPublicProfileMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 404 }));
    renderRoute("ghost");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be found/i);
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  // W5-IDENTITY appended cases: cursor pagination for a member's reports.
  it("offers no load-more action when the server reports no cursor", async () => {
    fetchFeedMock.mockResolvedValue({ items: [post], nextCursor: null, total: 1 });
    renderRoute();
    expect(await screen.findByText("Found a wallet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load more reports/i })).toBeNull();
  });

  it("pages forward with the server cursor and appends without duplicating", async () => {
    const second = { ...post, id: "p2", title: "Lost keys" };
    fetchFeedMock
      .mockResolvedValueOnce({ items: [post], nextCursor: "cursor-1", total: 2 })
      .mockResolvedValueOnce({ items: [post, second], nextCursor: null, total: 2 });
    renderRoute();
    const more = await screen.findByRole("button", { name: /load more reports/i });
    fireEvent.click(more);
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith({ userId: "u2" }, "cursor-1"),
    );
    expect(await screen.findByText("Lost keys")).toBeTruthy();
    // The repeated first-page row is deduped, not rendered twice.
    expect(screen.getAllByRole("link", { name: "Found a wallet" })).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more reports/i })).toBeNull(),
    );
  });

  it("keeps the loaded reports when the next page fails", async () => {
    fetchFeedMock
      .mockResolvedValueOnce({ items: [post], nextCursor: "cursor-1", total: 2 })
      .mockRejectedValueOnce(new Error("feed down"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /load more reports/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Found a wallet")).toBeTruthy();
    // The cursor is retained so the user can retry.
    expect(screen.getByRole("button", { name: /load more reports/i })).toBeTruthy();
  });
  // CF-060 R10: the profile reports row is one of the four mounts, and it is a
  // real mount test — the shield must sit OUTSIDE the SettingsRow link (its own
  // docs forbid an interactive control inside the row) and must not appear on
  // unflagged rows.
  it("shields only the flagged report row on a profile", async () => {
    fetchPublicProfileMock.mockResolvedValue(profile);
    fetchFeedMock.mockResolvedValue({
      items: [post, { ...post, id: "p2", title: "Blocked report", blockedAuthor: true }],
      nextCursor: null,
      total: 2,
    });
    renderRoute();

    const shields = await screen.findAllByTestId("blocked-shield");
    expect(shields).toHaveLength(1);
    const content = screen.getByTestId("blocked-shield-content");
    expect(content.getAttribute("inert")).not.toBeNull();

    // The reveal control is outside the row's anchor, never inside it.
    const reveal = screen.getByRole("button", { name: "Show content" });
    expect(reveal.closest("a")).toBeNull();
    expect(content.contains(reveal)).toBe(false);

    // The unblocked row stays an ordinary link.
    expect(screen.getByRole("link", { name: "Found a wallet" })).toBeTruthy();

    fireEvent.click(reveal);
    // Row mode never unmounts the warning: it stays in the same grid cell,
    // invisible and inert, so the row's box height is identical before and
    // after reveal (no jump for the rows below).
    const warning = screen.getByTestId("blocked-shield-warning");
    expect(warning.className).toContain("invisible");
    expect(warning.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("link", { name: /Blocked report/ })).toBeTruthy();
  });
});
