// @vitest-environment jsdom
/**
 * The administrator setup screen.
 *
 * The screen is the surface the owner was missing, and the properties under
 * test are the ones that make it honest:
 *
 *   1. The claim is CONFIRMED before it is sent. The irreversible step never
 *      happens on a single tap.
 *   2. A refusal is shown as the SERVER'S sentence, whole. A refusal is an
 *      answer about this account, and replacing it with generic advice would
 *      leave the owner guessing.
 *   3. Success says so plainly and offers the way to the staff console.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchBootstrapClaimStatus, mockBootstrapAdmin, authState } = vi.hoisted(() => ({
  mockFetchBootstrapClaimStatus: vi.fn(),
  mockBootstrapAdmin: vi.fn(),
  authState: { user: { id: "owner" } },
}));

vi.mock("../auth", () => ({ useAuth: () => authState }));

vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return {
    ...actual,
    fetchBootstrapClaimStatus: (...args: unknown[]) => mockFetchBootstrapClaimStatus(...args),
    bootstrapAdmin: (...args: unknown[]) => mockBootstrapAdmin(...args),
  };
});

import { AdminBootstrap } from "./AdminBootstrap";
import { ApiError } from "../services/session";

afterEach(cleanup);

const CAN_CLAIM = {
  canClaim: true,
  reason: null,
  alreadyAdmin: false,
  hasAdmin: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: "owner" };
  mockFetchBootstrapClaimStatus.mockResolvedValue(CAN_CLAIM);
  mockBootstrapAdmin.mockResolvedValue(undefined);
});

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/settings/administrator"]}>
      <Routes>
        <Route path="/settings/administrator" element={<AdminBootstrap />} />
        <Route path="/settings/team" element={<p>Team &amp; permissions</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the administrator setup screen", () => {
  it("moves focus to the confirmation text before offering the final action", async () => {
    renderScreen();
    fireEvent.click(await screen.findByText("Set up administrator access"));
    expect(document.activeElement?.textContent).toMatch(/Set up this account.*now\?/);
    expect(mockBootstrapAdmin).not.toHaveBeenCalled();
  });
  it("explains what claiming means in plain words", async () => {
    renderScreen();

    expect(
      await screen.findByText(/this account the administrator of FindBack/i),
    ).toBeTruthy();
    expect(screen.getByText(/one-time setup/i)).toBeTruthy();
  });

  it("does not claim until the owner confirms", async () => {
    renderScreen();

    const start = await screen.findByText("Set up administrator access");
    fireEvent.click(start);

    // The confirmation is asked for first; nothing is sent yet.
    expect(mockBootstrapAdmin).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Not now"));
    expect(mockBootstrapAdmin).not.toHaveBeenCalled();
    expect(screen.queryByText("Yes, set it up")).toBeNull();

    // And the second tap is the one that claims.
    fireEvent.click(screen.getByText("Set up administrator access"));
    fireEvent.click(screen.getByText("Yes, set it up"));

    await waitFor(() => expect(mockBootstrapAdmin).toHaveBeenCalledTimes(1));
  });

  it("confirms that the administrator role is active and offers the staff console", async () => {
    renderScreen();

    fireEvent.click(await screen.findByText("Set up administrator access"));
    fireEvent.click(screen.getByText("Yes, set it up"));

    expect(
      await screen.findByText(/administrator role is now active on this account/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Manage the team"));
    expect(await screen.findByText("Team & permissions")).toBeTruthy();
  });

  it("shows the SERVER's refusal sentence, whole", async () => {
    mockBootstrapAdmin.mockRejectedValue(
      new ApiError("An admin already exists", 403, "42501"),
    );
    renderScreen();

    fireEvent.click(await screen.findByText("Set up administrator access"));
    fireEvent.click(screen.getByText("Yes, set it up"));

    const refusal = await screen.findByTestId("admin-bootstrap-refusal");
    expect(refusal.textContent).toBe("An admin already exists");
    // The generic advice must NOT replace the server's own answer.
    expect(refusal.textContent).not.toMatch(/do not have permission/i);
  });

  it("shows the server's sentence when the account may not claim at all", async () => {
    mockFetchBootstrapClaimStatus.mockResolvedValue({
      canClaim: false,
      reason: "This account is not in the admin bootstrap list",
      alreadyAdmin: false,
      hasAdmin: false,
    });
    renderScreen();

    const closed = await screen.findByTestId("admin-bootstrap-closed");
    expect(closed.textContent).toBe("This account is not in the admin bootstrap list");
    // The claim is not offered to an account that may not make it.
    expect(screen.queryByText("Set up administrator access")).toBeNull();
    expect(mockBootstrapAdmin).not.toHaveBeenCalled();
  });

  it("shows the server's sentence for a confirmed-but-unconfirmed address", async () => {
    mockFetchBootstrapClaimStatus.mockResolvedValue({
      canClaim: false,
      reason: "Confirm your email address before claiming the admin role",
      alreadyAdmin: false,
      hasAdmin: false,
    });
    renderScreen();

    const closed = await screen.findByTestId("admin-bootstrap-closed");
    expect(closed.textContent).toBe(
      "Confirm your email address before claiming the admin role",
    );
  });

  it("keeps the screen usable when the answer cannot be read", async () => {
    mockFetchBootstrapClaimStatus.mockRejectedValue(new Error("network down"));
    renderScreen();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("never shows a raw id, a permission id or a JSON blob", async () => {
    renderScreen();

    await screen.findByText("Set up administrator access");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/user_id|role_id|capabilit|json|bootstrap_admins/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
