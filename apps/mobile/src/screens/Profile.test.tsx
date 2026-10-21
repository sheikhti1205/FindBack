// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
}));

const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    value: {
      id: "u1",
      username: "tester",
      email: "tester@example.com",
      phone: "+10000000000",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      displayName: "Tester Name",
      bio: null,
      locationLabel: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({ user: mockUser.value, logout: mockLogout }),
}));

import { Profile } from "./Profile";
import { ThemeProvider } from "../theme";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.value = {
    id: "u1",
    username: "tester",
    email: "tester@example.com",
    phone: "+10000000000",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    displayName: "Tester Name",
    bio: null,
    locationLabel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
});

function renderProfile() {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <Profile />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("Profile landing", () => {
  it("renders the header and identity hero with the canonical avatar fallback", () => {
    renderProfile();
    expect(screen.getByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(screen.getByText("Tester Name")).toBeTruthy();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    expect(screen.getByText("Email verified")).toBeTruthy();
    expect(screen.getByText("TE")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit profile" }).getAttribute("href")).toBe(
      "/profile/edit",
    );
  });

  it("links to the public profile route for the signed-in user", () => {
    renderProfile();
    const link = screen.getByRole("link", { name: /public profile/i });
    expect(link.getAttribute("href")).toBe("/u/tester");
  });

  it("offers a real Verify action when the email is unverified", () => {
    mockUser.value = { ...mockUser.value, emailVerified: false };
    renderProfile();
    expect(screen.queryByText("Email verified")).toBeNull();
    expect(screen.getByRole("link", { name: "Verify email" }).getAttribute("href")).toBe(
      "/verify",
    );
  });

  it("links Public profile, My reports, Saved reports, Settings and Help to their canonical routes", () => {
    renderProfile();
    const nav = screen.getByRole("navigation", { name: "Profile actions" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/u/tester",
      "/my",
      "/saved",
      "/settings",
      "/settings/help",
    ]);
    for (const link of links) expect(link.tagName).toBe("A");
    expect(within(nav).getByText("Public profile")).toBeTruthy();
    expect(within(nav).getByText("My reports")).toBeTruthy();
    expect(within(nav).getByText("Saved reports")).toBeTruthy();
    expect(within(nav).getByText("Settings")).toBeTruthy();
    expect(within(nav).getByText("Help & guide")).toBeTruthy();
  });

  it("removes debug-panel content: phone hero, appearance, AI links, self-test, about, logout", () => {
    renderProfile();
    expect(screen.queryByText("+10000000000")).toBeNull();
    expect(screen.queryByText(/phone verification/i)).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("link", { name: "AI Connection" })).toBeNull();
    expect(screen.queryByRole("link", { name: /models/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "About" })).toBeNull();
    expect(screen.queryByRole("button", { name: /log out|sign out/i })).toBeNull();
  });
});
