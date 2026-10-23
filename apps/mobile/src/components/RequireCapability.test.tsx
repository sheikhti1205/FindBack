// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const { mockFetchMyRole, viewer } = vi.hoisted(() => ({ mockFetchMyRole: vi.fn(), viewer: { id: "staff" } }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return { ...actual, fetchMyRole: (...args: unknown[]) => mockFetchMyRole(...args) };
});

import { RequireCapability } from "./RequireCapability";

afterEach(cleanup);

beforeEach(() => {
  mockFetchMyRole.mockReset();
  viewer.id = "staff";
});

function GuardFixture() {
  return (
    <MemoryRouter initialEntries={["/settings/moderation/queue"]}>
      <Routes>
        <Route
          path="/settings/moderation/queue"
          element={
            <RequireCapability capability="reports_review">
              <p>The queue</p>
            </RequireCapability>
          }
        />
        <Route path="/settings" element={<p>Settings</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderGuard() { return render(<GuardFixture />); }

describe("a route that needs one permission", () => {
  it("hides the previous account's privileged surface while the new role is pending", async () => {
    let resolveNext!: (value: unknown) => void;
    mockFetchMyRole.mockResolvedValueOnce({ role: "ADMIN", isAdmin: true, capabilities: [] })
      .mockReturnValueOnce(new Promise((done) => { resolveNext = done; }));
    const { rerender } = renderGuard();
    await screen.findByText("The queue");
    viewer.id = "reader";
    rerender(<GuardFixture />);
    expect(screen.queryByText("The queue")).toBeNull();
    await waitFor(() => expect(mockFetchMyRole).toHaveBeenCalledTimes(2));
    resolveNext({ role: null, isAdmin: false, capabilities: [] });
    expect(await screen.findByText("Settings")).toBeTruthy();
  });

  it("opens for an account that holds it", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["reports_review", "content_hide"],
    });
    renderGuard();
    expect(await screen.findByText("The queue")).toBeTruthy();
  });

  it("sends an ordinary reader back to Settings", async () => {
    mockFetchMyRole.mockResolvedValue({ role: null, isAdmin: false, capabilities: [] });
    renderGuard();
    expect(await screen.findByText("Settings")).toBeTruthy();
    expect(screen.queryByText("The queue")).toBeNull();
  });

  it("sends a moderator without the permission back too", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["content_hide"],
    });
    renderGuard();
    expect(await screen.findByText("Settings")).toBeTruthy();
  });

  it("fails closed when the role cannot be read", async () => {
    mockFetchMyRole.mockRejectedValue(new Error("offline"));
    renderGuard();
    await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
  });
});
