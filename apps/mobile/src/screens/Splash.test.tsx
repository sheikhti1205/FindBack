// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  user: null as null | { id: string },
  booting: true,
  bootError: null as string | null,
  retryBoot: vi.fn(),
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ ...authState }),
}));

import { Splash } from "./Splash";

afterEach(cleanup);

describe("Splash", () => {
  it("shows the brand mark while booting", () => {
    authState.user = null;
    authState.booting = true;
    authState.bootError = null;
    render(<MemoryRouter><Splash /></MemoryRouter>);
    expect(screen.getByText("FindBack")).toBeTruthy();
  });

  it("offers Retry without signing out when the backend is unreachable", () => {
    authState.user = null;
    authState.booting = false;
    authState.bootError = "unreachable";
    authState.retryBoot.mockClear();
    render(<MemoryRouter><Splash /></MemoryRouter>);
    expect(screen.getByText(/couldn't connect to findback/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(authState.retryBoot).toHaveBeenCalledTimes(1);
  });
});
