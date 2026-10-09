// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostItem, PublicProfile as PublicProfileShape } from "@findback/shared";

const { fetchPublicProfileMock, fetchFeedMock } = vi.hoisted(() => ({
  fetchPublicProfileMock: vi.fn(),
  fetchFeedMock: vi.fn(),
}));

vi.mock("../services/profile", () => ({ fetchPublicProfile: fetchPublicProfileMock }));
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
  fetchPublicProfileMock.mockResolvedValue(profile);
  fetchFeedMock.mockResolvedValue({ items: [post], nextCursor: null, total: 1 });
});

describe("PublicProfile", () => {
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
});
