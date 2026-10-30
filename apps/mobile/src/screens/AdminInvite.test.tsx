// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGrantRole, mockListRoleAssignments } = vi.hoisted(() => ({
  mockGrantRole: vi.fn(),
  mockListRoleAssignments: vi.fn(),
}));

// The service is mocked, not the network: the real vocabulary and the real
// human labels stay, only the server call is replaced.
vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return {
    ...actual,
    grantRole: (...args: unknown[]) => mockGrantRole(...args),
    listRoleAssignments: () => mockListRoleAssignments(),
  };
});

import { AdminInvite } from "./AdminInvite";
import { ApiError } from "../services/session";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockGrantRole.mockResolvedValue({
    kind: "account",
    email: "sam@example.com",
    role: "MODERATOR",
  });
  mockListRoleAssignments.mockResolvedValue([]);
});

function renderInvite() {
  render(
    <MemoryRouter>
      <AdminInvite />
    </MemoryRouter>,
  );
}

function typeEmail(address: string) {
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: address },
  });
}

describe("adding someone by email", () => {
  it("a denied membership read cannot be bypassed by acknowledging an unknown replacement", async () => {
    mockListRoleAssignments.mockRejectedValueOnce(new ApiError("revoked", 403, "42501"));
    renderInvite();typeEmail("private@example.com");
    await act(async () => { await Promise.resolve(); });
    const acknowledgement = screen.queryByLabelText(/replace their current role and permissions/i);
    if (acknowledgement) fireEvent.click(acknowledgement);
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", true);
    expect(screen.queryByDisplayValue("private@example.com")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("a denied role write discards the private draft and disables further grants", async () => {
    mockGrantRole.mockRejectedValueOnce(new ApiError("revoked", 403, "42501"));
    renderInvite();typeEmail("private@example.com");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));await screen.findByRole("alert");
    expect(screen.queryByDisplayValue("private@example.com")).toBeNull();
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", true);
  });
  it("says so when the role landed on an existing account", async () => {
    renderInvite();
    typeEmail("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/sam@example\.com now has moderator access/i);
  });

  it("says the invitation waits for the signup when it did", async () => {
    mockGrantRole.mockResolvedValue({
      kind: "invitation",
      email: "new@example.com",
      role: "MODERATOR",
    });
    renderInvite();
    typeEmail("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/as soon as they sign up with that address/i);
  });

  it("sends the address, the role and the ticked permissions", async () => {
    renderInvite();
    typeEmail("sam@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: "Review reports" }));
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    await waitFor(() =>
      expect(mockGrantRole).toHaveBeenCalledWith("sam@example.com", "MODERATOR", [
        "reports_review",
      ]),
    );
  });

  it("never offers the permissions that stay with the admin", () => {
    renderInvite();
    for (const name of [
      "Manage roles and moderators",
      "Manage app settings",
      "Export data",
      "Delete data",
    ]) {
      expect(screen.queryByRole("checkbox", { name })).toBeNull();
    }
  });

  it("shows the server's refusal as a message instead of crashing", async () => {
    mockGrantRole.mockRejectedValue(
      new ApiError("Only an admin may assign roles", 403, "42501"),
    );
    renderInvite();
    typeEmail("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only an admin may give someone a role/i);
  });

  it("does not send an address that is not an email address", async () => {
    renderInvite();
    typeEmail("not-an-address");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    expect(await screen.findByText(/enter a valid email address/i)).toBeTruthy();
    expect(mockGrantRole).not.toHaveBeenCalled();
  });

  it("offers the admin role without ticking anything for it", async () => {
    renderInvite();
    typeEmail("boss@example.com");
    fireEvent.click(screen.getByRole("radio", { name: /admin/i }));
    expect(screen.queryByRole("checkbox", { name: "Review reports" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    await waitFor(() =>
      expect(mockGrantRole).toHaveBeenCalledWith("boss@example.com", "ADMIN", []),
    );
  });
});

describe("giving access to someone who already has a role", () => {
  beforeEach(() => {
    mockListRoleAssignments.mockResolvedValue([
      {
        userId: "u-sam",
        email: "sam@example.com",
        username: "sam",
        role: "MODERATOR",
        capabilities: ["reports_review"],
        grantedAt: "2026-10-20T00:00:00.000Z",
      },
    ]);
  });

  it("says what is already there and what giving access again will do", async () => {
    renderInvite();
    typeEmail("sam@example.com");
    expect(await screen.findByText(/already has moderator access/i)).toBeTruthy();
    expect(screen.getByText(/replaces the current role and permissions/i)).toBeTruthy();
    // The consequence is named before the control can be pressed.
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", true);
  });

  it("lets the admin replace it once they acknowledge", async () => {
    renderInvite();
    typeEmail("sam@example.com");
    await screen.findByText(/already has moderator access/i);
    fireEvent.click(screen.getByLabelText(/replace their current role and permissions/i));
    const button = screen.getByRole("button", { name: /give access/i });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    await waitFor(() => expect(mockGrantRole).toHaveBeenCalled());
  });

  it("does not warn about an address that holds nothing", async () => {
    mockListRoleAssignments.mockResolvedValue([]);
    renderInvite();
    typeEmail("new@example.com");
    await waitFor(() => expect(mockListRoleAssignments).toHaveBeenCalled());
    expect(screen.queryByText(/already has/i)).toBeNull();
  });
});

describe("the confirmation tells the server's truth", () => {
  it("names the role the server granted, not the radio still on screen", async () => {
    // The radio is left on Moderator; the server answers ADMIN. The sentence
    // must follow the server.
    mockGrantRole.mockResolvedValue({ kind: "account", email: "sam@example.com", role: "ADMIN" });
    renderInvite();
    typeEmail("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: /give access/i }));
    expect(await screen.findByText(/sam@example.com now has admin access/i)).toBeTruthy();
    expect(screen.queryByText(/now has moderator access/i)).toBeNull();
  });
});

describe("when the membership list cannot be read", () => {
  it("asks before it can replace a role it could not check", async () => {
    mockListRoleAssignments.mockRejectedValue(new Error("offline"));
    renderInvite();
    typeEmail("someone@example.com");
    expect(await screen.findByText(/could not check whether this address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/replace their current role and permissions/i));
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", false);
  });

  it("forgets the acknowledgement when the address changes", async () => {
    mockListRoleAssignments.mockResolvedValue([
      {
        userId: "u-sam",
        email: "sam@example.com",
        username: "sam",
        role: "MODERATOR",
        capabilities: ["reports_review"],
        grantedAt: "2026-10-20T00:00:00.000Z",
      },
    ]);
    renderInvite();
    typeEmail("sam@example.com");
    await screen.findByText(/already has moderator access/i);
    fireEvent.click(screen.getByLabelText(/replace their current role and permissions/i));
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", false);

    typeEmail("sam2@example.com");
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", false);
    // Moving back to the person who holds a role needs the tick again.
    typeEmail("sam@example.com");
    expect(screen.getByRole("button", { name: /give access/i })).toHaveProperty("disabled", true);
  });
});
