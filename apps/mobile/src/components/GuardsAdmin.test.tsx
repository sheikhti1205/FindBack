// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const roles = vi.hoisted(() => ({
  fetchMyRole: vi.fn(),
}));

vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return { ...actual, fetchMyRole: () => roles.fetchMyRole() };
});

import { RequireAdmin } from "./Guards";

afterEach(() => {
  cleanup();
  roles.fetchMyRole.mockReset();
});

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}</output>;
}

function renderConsole(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Location />
      <Routes>
        <Route
          path="/settings/team"
          element={
            <RequireAdmin>
              <p>the team</p>
            </RequireAdmin>
          }
        />
        <Route path="/settings" element={<p>settings</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAdmin", () => {
  it("renders the console for an admin", async () => {
    roles.fetchMyRole.mockResolvedValue({ isAdmin: true, role: "ADMIN", capabilities: [] });
    renderConsole("/settings/team");
    expect(await screen.findByText("the team")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/settings/team");
  });

  it("sends a moderator back to Settings without rendering the console", async () => {
    roles.fetchMyRole.mockResolvedValue({ isAdmin: false, role: "MODERATOR", capabilities: ["reports_review"] });
    renderConsole("/settings/team");
    expect(await screen.findByText("settings")).toBeTruthy();
    expect(screen.queryByText("the team")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/settings");
  });

  it("treats a failed role read as not an admin", async () => {
    roles.fetchMyRole.mockRejectedValue(new Error("network"));
    renderConsole("/settings/team");
    expect(await screen.findByText("settings")).toBeTruthy();
    expect(screen.queryByText("the team")).toBeNull();
  });

  it("shows nothing while the role is still unknown", () => {
    roles.fetchMyRole.mockReturnValue(new Promise(() => {}));
    renderConsole("/settings/team");
    expect(screen.queryByText("the team")).toBeNull();
    expect(screen.queryByText("settings")).toBeNull();
  });

});
