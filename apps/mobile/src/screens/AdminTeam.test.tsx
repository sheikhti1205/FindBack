// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchMyRole,
  mockListRoleAssignments,
  mockListRoleInvitations,
  mockRevokeRole,
  mockSetRoleCapabilities,
} = vi.hoisted(() => ({
  mockFetchMyRole: vi.fn(),
  mockListRoleAssignments: vi.fn(),
  mockListRoleInvitations: vi.fn(),
  mockRevokeRole: vi.fn(),
  mockSetRoleCapabilities: vi.fn(),
}));

// The service is mocked, not the network: the real vocabulary and the real
// human labels stay, only the server calls are replaced.
vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return {
    ...actual,
    fetchMyRole: (...args: unknown[]) => mockFetchMyRole(...args),
    listRoleAssignments: (...args: unknown[]) => mockListRoleAssignments(...args),
    listRoleInvitations: (...args: unknown[]) => mockListRoleInvitations(...args),
    revokeRole: (...args: unknown[]) => mockRevokeRole(...args),
    setRoleCapabilities: (...args: unknown[]) => mockSetRoleCapabilities(...args),
  };
});

import { AdminTeam } from "./AdminTeam";
import { ApiError } from "../services/session";

afterEach(cleanup);

const MODERATOR = {
  userId: "u1",
  username: "sam",
  email: "sam@example.com",
  role: "MODERATOR" as const,
  capabilities: ["reports_review", "content_hide"],
  grantedAt: "2026-10-22T09:00:00.000Z",
};

const ADMIN = {
  userId: "u2",
  username: "boss",
  email: "boss@example.com",
  role: "ADMIN" as const,
  capabilities: [],
  grantedAt: "2026-10-22T09:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchMyRole.mockResolvedValue({
    role: "ADMIN",
    isAdmin: true,
    capabilities: ["reports_review", "content_hide", "audit_read", "roles_manage"],
  });
  mockListRoleAssignments.mockResolvedValue([MODERATOR, ADMIN]);
  mockListRoleInvitations.mockResolvedValue([]);
  mockRevokeRole.mockResolvedValue(undefined);
  mockSetRoleCapabilities.mockResolvedValue(undefined);
});

function renderTeam() {
  render(
    <MemoryRouter>
      <AdminTeam />
    </MemoryRouter>,
  );
}

describe("the team", () => {
  it("a late removal never starts privileged readback after the account-scoped team unmounts", async () => {
    let finish!: () => void;
    mockRevokeRole.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<MemoryRouter><AdminTeam /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole("button", { name: /^remove role$/i }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: /yes, remove role/i }));
    view.unmount();
    await act(async () => { finish(); });
    expect(mockListRoleAssignments).toHaveBeenCalledTimes(1);
    expect(mockListRoleInvitations).toHaveBeenCalledTimes(1);
  });
  it("a denied removal purges private membership data and all mutation affordances", async () => {
    mockRevokeRole.mockRejectedValueOnce(new ApiError("revoked", 403, "42501"));
    renderTeam();
    fireEvent.click((await screen.findAllByRole("button", { name: /^remove role$/i }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: /yes, remove role/i }));
    await screen.findByRole("alert");
    expect(screen.queryByText("sam@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: /change permissions/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /add a moderator/i })).toBeNull();
  });
  it("a denied capability save purges the parent team and editor", async () => {
    mockSetRoleCapabilities.mockRejectedValueOnce(new ApiError("revoked", 403, "42501"));
    renderTeam();
    fireEvent.click(await screen.findByRole("button", { name: /change permissions/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("sam@example.com")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Warn members" })).toBeNull();
  });
  it("a denied membership read discards a separately successful private invitation list", async () => {
    mockListRoleAssignments.mockRejectedValueOnce(new ApiError("revoked", 403, "42501"));
    mockListRoleInvitations.mockResolvedValueOnce([{ id: "inv-private", email: "private@example.com", role: "MODERATOR", capabilities: [], invitedAt: "2026-10-22T00:00:00Z", acceptedAt: null, revokedAt: null }]);
    renderTeam();await screen.findByRole("alert");
    expect(screen.queryByText("private@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel invitation" })).toBeNull();
  });
  it("lists the people who hold a role with their permissions in words", async () => {
    renderTeam();
    expect(await screen.findByText("sam@example.com")).toBeTruthy();
    expect(screen.getByText("boss@example.com")).toBeTruthy();
    expect(screen.getByText("Review reports, Hide and publish content")).toBeTruthy();
    expect(screen.getByText(/full access/i)).toBeTruthy();
  });

  it("never shows a raw permission id", async () => {
    renderTeam();
    await screen.findByText("sam@example.com");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("reports_review");
    expect(text).not.toContain("content_hide");
    expect(text).not.toContain("roles_manage");
  });

  it("says so when there is nobody on the team yet", async () => {
    mockListRoleAssignments.mockResolvedValue([]);
    renderTeam();
    expect(await screen.findByText(/no moderators yet/i)).toBeTruthy();
  });

  it("shows the server's refusal instead of the team", async () => {
    mockListRoleAssignments.mockRejectedValue(
      new ApiError("Only an admin may read the role list", 403, "42501"),
    );
    renderTeam();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only an admin can see the team list/i);
  });

  it("changes one person's permissions and sends the changed set", async () => {
    renderTeam();
    const edit = await screen.findByRole("button", { name: /change permissions/i });
    fireEvent.click(edit);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));

    await waitFor(() =>
      expect(mockSetRoleCapabilities).toHaveBeenCalledWith("sam@example.com", [
        "reports_review",
        "content_hide",
        "members_warn",
      ]),
    );
  });

  it("confirms the save on the page after the editor closes", async () => {
    renderTeam();
    fireEvent.click(await screen.findByRole("button", { name: /change permissions/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Warn members" }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));
    expect(await screen.findByText(/saved\. sam@example\.com has the permissions shown here now/i)).toBeTruthy();
  });

  it("never offers to change an admin's permissions", async () => {
    renderTeam();
    await screen.findByText("boss@example.com");
    // One person can be edited: the moderator. The admin's set is not per-row.
    expect(screen.getAllByRole("button", { name: /change permissions/i })).toHaveLength(1);
  });

  it("takes a role away after the admin confirms", async () => {
    renderTeam();
    // The moderator is listed first, so the first "Remove role" is theirs.
    const remove = (await screen.findAllByRole("button", { name: /^remove role$/i }))[0]!;
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: /yes, remove role/i }));
    await waitFor(() => expect(mockRevokeRole).toHaveBeenCalledWith("sam@example.com"));
  });

  it("keeps the role when the admin changes their mind", async () => {
    renderTeam();
    const remove = (await screen.findAllByRole("button", { name: /^remove role$/i }))[0]!;
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: /keep it/i }));
    expect(mockRevokeRole).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when a role cannot be taken away", async () => {
    mockRevokeRole.mockRejectedValue(
      new ApiError("The last admin cannot be revoked", 403, "42501"),
    );
    renderTeam();
    const remove = (await screen.findAllByRole("button", { name: /^remove role$/i }))[0]!;
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: /yes, remove role/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only an admin may take a role away/i);
  });

  it("offers the admin surfaces to an admin", async () => {
    renderTeam();
    expect(await screen.findByRole("link", { name: /add a moderator/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /activity log/i })).toBeTruthy();
  });

  it("offers a moderator neither the team tools nor the activity log", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["reports_review"],
    });
    renderTeam();
    await screen.findByText("Loading the team…");
    expect(screen.queryByRole("link", { name: /add a moderator/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /activity log/i })).toBeNull();
  });

  it("shows a pending invitation as waiting for the signup", async () => {
    mockListRoleInvitations.mockResolvedValue([
      {
        id: "inv-1",
        email: "new@example.com",
        role: "MODERATOR",
        capabilities: ["reports_review"],
        invitedAt: "2026-10-22T10:00:00.000Z",
        acceptedAt: null,
        revokedAt: null,
      },
    ]);
    renderTeam();
    expect(await screen.findByText("new@example.com")).toBeTruthy();
    expect(screen.getByText(/waiting to join/i)).toBeTruthy();
  });
});
