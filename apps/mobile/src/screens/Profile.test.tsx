// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    logout: vi.fn(),
  }),
}));

import { Profile } from "./Profile";
import { ThemeProvider } from "../theme";

afterEach(cleanup);

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
