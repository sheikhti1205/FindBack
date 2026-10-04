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
  it("renders the header, identity hero, and edit action", () => {
    renderProfile();
    expect(screen.getByRole("heading", { level: 1, name: "Profile" })).toBeTruthy();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    expect(screen.getByText("Email verified")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit profile" }).getAttribute("href")).toBe(
      "/profile/edit",
    );
  });

  it("offers a real Verify action when the email is unverified", () => {
    mockUser.value = { ...mockUser.value, emailVerified: false };
    renderProfile();
    expect(screen.queryByText("Email verified")).toBeNull();
    expect(screen.getByRole("link", { name: "Verify email" }).getAttribute("href")).toBe(
      "/verify",
    );
  });

  it("links My reports and Settings to their canonical routes", () => {
    renderProfile();
    const nav = screen.getByRole("navigation", { name: "Profile actions" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["My reports", "/my"],
      ["Settings", "/settings"],
      ["Help & guide", "/settings/help"],
    ]);
    for (const link of links) expect(link.tagName).toBe("A");
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
