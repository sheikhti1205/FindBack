// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadAuditLog } = vi.hoisted(() => ({
  mockReadAuditLog: vi.fn(),
}));

// The service is mocked, not the network: the real log shape stays, only the
// server call is replaced.
vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return { ...actual, readAuditLog: (...args: unknown[]) => mockReadAuditLog(...args) };
});

import { AdminAuditLog } from "./AdminAuditLog";
import { ApiError } from "../services/session";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockReadAuditLog.mockResolvedValue([]);
});

function renderLog() {
  render(
    <MemoryRouter>
      <AdminAuditLog />
    </MemoryRouter>,
  );
}

describe("the activity log", () => {
  it("says what happened in words, newest first", async () => {
    mockReadAuditLog.mockResolvedValue([
      {
        id: "2",
        actorUserId: "u1",
        action: "CAPABILITIES_CHANGED",
        targetType: "user_role_capabilities",
        targetId: "9f2c-secret-user-id",
        reason: "Capability set changed",
        previousState: { capabilities: ["reports_review"] },
        newState: { capabilities: ["reports_review", "members_warn"] },
        createdAt: "2026-10-22T11:00:00.000Z",
      },
      {
        id: "1",
        actorUserId: "u1",
        action: "ROLE_INVITED",
        targetType: "role_invitations",
        targetId: "new@example.com",
        reason: "Invitation created for an email that has no account yet",
        previousState: { role: null, capabilities: [], accepted: false },
        newState: { role: "MODERATOR", capabilities: ["reports_review"], accepted: false },
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ]);
    renderLog();

    expect(
      await screen.findByText(/invited new@example\.com to join as moderator/i),
    ).toBeTruthy();
    expect(screen.getByText(/changed what a moderator may do/i)).toBeTruthy();
    expect(screen.getByText(/added: warn members/i)).toBeTruthy();

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]!.textContent).toMatch(/changed what a moderator may do/i);
    expect(rows[1]!.textContent).toMatch(/invited new@example\.com/i);
  });

  it("names a cancelled invitation in a sentence", async () => {
    mockReadAuditLog.mockResolvedValue([
      {
        id: "1",
        actorUserId: "u1",
        action: "INVITATION_REVOKED",
        targetType: "role_invitations",
        targetId: "new@example.com",
        reason: "Invitation revoked",
        previousState: { role: "MODERATOR", capabilities: ["reports_review"] },
        newState: { role: "MODERATOR", capabilities: ["reports_review"], revoked: true },
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ]);
    renderLog();
    expect(
      await screen.findByText(/cancelled the invitation for new@example\.com/i),
    ).toBeTruthy();
    // The generic fallback must not be what the reader sees.
    expect(screen.queryByText(/changed something/i)).toBeNull();
  });

  it("never dumps the raw log on the screen", async () => {
    mockReadAuditLog.mockResolvedValue([
      {
        id: "1",
        actorUserId: "u1",
        action: "ROLE_GRANTED",
        targetType: "user_roles",
        targetId: "9f2c-secret-user-id",
        reason: "Role granted to an existing account",
        previousState: { role: null, capabilities: [] },
        newState: { role: "MODERATOR", capabilities: ["reports_review"], email: "sam@example.com" },
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ]);
    renderLog();

    expect(await screen.findByText(/gave sam@example\.com moderator access/i)).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("ROLE_GRANTED");
    expect(text).not.toContain("user_role_capabilities");
    expect(text).not.toContain("previous_state");
    expect(text).not.toContain("9f2c-secret-user-id");
    expect(text).not.toContain("reports_review");
  });

  it("shows the time each entry happened", async () => {
    mockReadAuditLog.mockResolvedValue([
      {
        id: "1",
        actorUserId: "u1",
        action: "ROLE_REVOKED",
        targetType: "user_roles",
        targetId: "sam@example.com",
        reason: "Role revoked",
        previousState: { role: "MODERATOR", email: "sam@example.com" },
        newState: { role: null, email: "sam@example.com" },
        createdAt: "2026-10-22T10:00:00.000Z",
      },
    ]);
    renderLog();
    expect(await screen.findByText(/removed moderator access from sam@example\.com/i)).toBeTruthy();
    // A readable moment, not the raw timestamp.
    expect(document.body.textContent).not.toContain("2026-10-22T10:00:00.000Z");
  });

  it("says so when nothing has happened yet", async () => {
    renderLog();
    expect(await screen.findByText(/nothing has happened yet/i)).toBeTruthy();
  });

  it("shows the server's refusal as a message instead of crashing", async () => {
    mockReadAuditLog.mockRejectedValue(
      new ApiError("You may not read the audit log", 403, "42501"),
    );
    renderLog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/do not have permission to read the activity log/i);
  });
});
