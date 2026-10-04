// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
      email: "tester@example.com",
      phone: "+10000000000",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    logout: mockLogout,
    refreshUser: vi.fn(),
  }),
}));

import { Profile } from "./Profile";
import { ThemeProvider } from "../theme";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Profile help destination", () => {
  it("labels the help destination Help & FAQ and keeps the /help route", () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <Profile />
        </ThemeProvider>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Help & FAQ" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/help");
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
  });
});

describe("Profile motion", () => {
  function renderProfile() {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <Profile />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("keeps every row's destination and name (press-state wrap regression guard)", () => {
    renderProfile();
    const nav = screen.getByRole("navigation", { name: "Profile links" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Edit profile", "/profile/edit"],
      ["My reports", "/my"],
      ["Help & FAQ", "/help"],
      ["AI Connection", "/ai-connection"],
      ["AI & Models", "/ai-models"],
      ["About", "/about"],
    ]);
    // Still real anchors — the motion wrapper must not swallow navigation.
    for (const link of links) expect(link.tagName).toBe("A");
  });

  it("slides the reused theme selector indicator to the chosen theme", () => {
    renderProfile();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const dark = within(group).getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    for (const name of ["System", "Light"]) {
      expect(within(group).getByRole("radio", { name }).getAttribute("aria-checked")).toBe("false");
    }
    // The shared sliding pill (Segmented-owned, reused — not edited).
    expect(dark.querySelector('[data-testid="segmented-selection"]')).toBeTruthy();
  });
});

