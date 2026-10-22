import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ONLY_CAPABILITIES,
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  MODERATOR_CAPABILITIES,
  bootstrapAdmin,
  capabilityLabel,
  fetchMyRole,
  grantRole,
  listRoleAssignments,
  listRoleInvitations,
  readAuditLog,
  revokeRole,
  setRoleCapabilities,
} from "./roles";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
});

function lastCall(name: string): { args: Record<string, unknown> } {
  const call = clientMock.rpc.mock.calls.find((entry) => entry[0] === name);
  expect(call, `${name} was called`).toBeTruthy();
  return { args: call![1] as Record<string, unknown> };
}

describe("the capability vocabulary", () => {
  it("names every moderator-assignable capability the owner agreed on", () => {
    expect([...MODERATOR_CAPABILITIES]).toEqual([
      "reports_review",
      "content_hide",
      "content_remove",
      "members_warn",
      "members_restrict",
      "members_suspend",
      "feedback_read",
      "appeals_review",
      "audit_read",
      "matches_confirm",
    ]);
  });

  it("keeps the admin-only capabilities out of the moderator set", () => {
    expect([...ADMIN_ONLY_CAPABILITIES]).toEqual([
      "roles_manage",
      "settings_manage",
      "data_export",
      "data_delete",
    ]);
    for (const capability of ADMIN_ONLY_CAPABILITIES) {
      expect(MODERATOR_CAPABILITIES as readonly string[]).not.toContain(capability);
    }
    expect(ALL_CAPABILITIES).toHaveLength(
      MODERATOR_CAPABILITIES.length + ADMIN_ONLY_CAPABILITIES.length,
    );
  });

  it("has a human label for every capability — the raw id is never shown", () => {
    for (const capability of ALL_CAPABILITIES) {
      const label = CAPABILITY_LABELS[capability];
      expect(label, `${capability} has a label`).toBeTruthy();
      expect(label).not.toBe(capability);
    }
  });

  it("names a capability the app knows, and never renders an unknown id raw", () => {
    expect(capabilityLabel("reports_review")).toBe("Review reports");
    // An id the app has never heard of has no honest label, so it is NOT
    // shown raw.
    expect(capabilityLabel("delete_everything")).toBe("Unknown capability");
    expect(capabilityLabel("delete_everything")).not.toContain("delete_everything");
  });
});

describe("fetchMyRole", () => {
  it("reads the role from the server and maps the answer", async () => {
    clientMock.rpc.mockResolvedValue({
      data: { role: "MODERATOR", is_admin: false, capabilities: ["reports_review", "content_hide"] },
      error: null,
    });

    const mine = await fetchMyRole();

    expect(mine).toEqual({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["reports_review", "content_hide"],
    });
    expect(lastCall("findback_my_role").args).toEqual({});
  });

  it("reports an ordinary account as no role and no capability", async () => {
    clientMock.rpc.mockResolvedValue({
      data: { role: null, is_admin: false, capabilities: [] },
      error: null,
    });

    const mine = await fetchMyRole();

    expect(mine.role).toBeNull();
    expect(mine.isAdmin).toBe(false);
    expect(mine.capabilities).toEqual([]);
  });

  it("never invents a role the server did not name", async () => {
    clientMock.rpc.mockResolvedValue({
      data: { role: "SUPERUSER", is_admin: "yes", capabilities: ["reports_review", 7] },
      error: null,
    });

    const mine = await fetchMyRole();

    expect(mine.role).toBeNull();
    expect(mine.isAdmin).toBe(false);
    expect(mine.capabilities).toEqual(["reports_review"]);
  });

  it("never carries a capability the app cannot name", async () => {
    clientMock.rpc.mockResolvedValue({
      data: {
        role: "MODERATOR",
        is_admin: false,
        capabilities: ["reports_review", "delete_everything", "roles_manage", 7, null],
      },
      error: null,
    });

    const mine = await fetchMyRole();

    // A garbled server answer cannot inject a capability the app has never
    // heard of: every id the app cannot label is dropped.
    expect(mine.capabilities).toEqual(["reports_review", "roles_manage"]);
    for (const capability of mine.capabilities) {
      expect(ALL_CAPABILITIES).toContain(capability);
    }
  });

  it("surfaces the server's refusal as a real answer", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "nope", code: "42501" } });

    await expect(fetchMyRole()).rejects.toMatchObject({ status: 403, code: "42501" });
  });
});

describe("the admin-only management calls", () => {
  it("lists the team with its capability sets", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          user_id: "u2",
          username: "mod",
          email: "mod@example.com",
          role: "MODERATOR",
          capabilities: ["reports_review"],
          granted_at: "2026-10-22T00:00:00.000Z",
        },
      ],
      error: null,
    });

    const team = await listRoleAssignments();

    expect(team).toEqual([
      {
        userId: "u2",
        username: "mod",
        email: "mod@example.com",
        role: "MODERATOR",
        capabilities: ["reports_review"],
        grantedAt: "2026-10-22T00:00:00.000Z",
      },
    ]);
  });

  it("lists the email invitations with their state", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "new@example.com",
          role: "MODERATOR",
          capabilities: ["reports_review", "content_hide"],
          invited_at: "2026-10-22T00:00:00.000Z",
          accepted_at: null,
          revoked_at: null,
        },
      ],
      error: null,
    });

    const invitations = await listRoleInvitations();

    expect(invitations.at(0)?.email).toBe("new@example.com");
    expect(invitations.at(0)?.acceptedAt).toBeNull();
    expect(invitations.at(0)?.revokedAt).toBeNull();
  });

  it("drops a team row or an invitation whose role it does not know", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          user_id: "u1",
          username: "someone",
          email: "someone@example.com",
          role: "SUPERUSER",
          capabilities: ["reports_review"],
          granted_at: "2026-10-22T00:00:00.000Z",
        },
      ],
      error: null,
    });

    expect(await listRoleAssignments()).toEqual([]);

    clientMock.rpc.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "new@example.com",
          role: "SUPERUSER",
          capabilities: ["reports_review"],
          invited_at: "2026-10-22T00:00:00.000Z",
          accepted_at: null,
          revoked_at: null,
        },
      ],
      error: null,
    });

    expect(await listRoleInvitations()).toEqual([]);
  });

  it("grants by email and reports whether it landed on an account or waits as an invitation", async () => {
    clientMock.rpc.mockResolvedValue({
      data: { kind: "invitation", email: "new@example.com", role: "MODERATOR" },
      error: null,
    });

    const outcome = await grantRole("new@example.com", "MODERATOR", ["reports_review"]);

    expect(outcome.kind).toBe("invitation");
    expect(lastCall("findback_role_grant").args).toEqual({
      p_email: "new@example.com",
      p_role: "MODERATOR",
      p_capabilities: ["reports_review"],
    });
  });

  it("never invents a kind or a role the server did not name", async () => {
    // A garbled answer must not be rounded up to "invitation" or
    // "MODERATOR": the console would then show a state the server never
    // reported.
    clientMock.rpc.mockResolvedValue({
      data: { kind: "something", email: "new@example.com", role: "SUPERUSER" },
      error: null,
    });

    await expect(grantRole("new@example.com", "MODERATOR", [])).rejects.toMatchObject({
      status: 500,
      code: "UNEXPECTED_SHAPE",
    });

    clientMock.rpc.mockResolvedValue({
      data: { kind: "account", email: "new@example.com", role: "SUPERUSER" },
      error: null,
    });

    await expect(grantRole("new@example.com", "MODERATOR", [])).rejects.toMatchObject({
      status: 500,
      code: "UNEXPECTED_SHAPE",
    });
  });

  it("tells a server fault from a refusal, and never reports a transport failure as a bad request", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Only an admin may assign roles", code: "42501" },
    });
    await expect(grantRole("new@example.com", "MODERATOR", [])).rejects.toMatchObject({
      status: 403,
    });

    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Unknown capability", code: "22023" },
    });
    await expect(grantRole("new@example.com", "MODERATOR", [])).rejects.toMatchObject({
      status: 400,
    });

    // A missing function (PGRST202, before the roles migration is applied)
    // is a server trouble, not a wrong request.
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "Could not find the function", code: "PGRST202" },
    });
    await expect(grantRole("new@example.com", "MODERATOR", [])).rejects.toMatchObject({
      status: 500,
      code: "PGRST202",
    });
  });

  it("replaces an account capability set and returns the server's actual destination", async () => {
    clientMock.rpc.mockResolvedValue({ data: { kind: "account", email: "mod@example.com", user_id: "u2" }, error: null });

    expect(await setRoleCapabilities("mod@example.com", ["content_hide"])).toEqual({
      kind: "account", email: "mod@example.com", userId: "u2",
    });

    expect(lastCall("findback_role_set_capabilities").args).toEqual({
      p_email: "mod@example.com",
      p_capabilities: ["content_hide"],
    });
  });

  it("returns invitation when the pending invitation, not an account, was edited", async () => {
    clientMock.rpc.mockResolvedValue({ data: { kind: "invitation", email: "new@example.com" }, error: null });
    expect(await setRoleCapabilities("new@example.com", [])).toEqual({ kind: "invitation", email: "new@example.com" });
  });

  it.each([
    null, {}, { kind: "other", email: "mod@example.com" },
    { kind: "account", email: "mod@example.com" },
    { kind: "account", email: "mod@example.com", user_id: "" },
    { kind: "invitation", email: "" }, { kind: "invitation", email: 42 },
  ])("does not invent a capability-change destination for malformed response %j", async (data) => {
    clientMock.rpc.mockResolvedValue({ data, error: null });
    await expect(setRoleCapabilities("mod@example.com", [])).rejects.toMatchObject({ status: 500, code: "UNEXPECTED_SHAPE" });
  });

  it("preserves capability-change refusal rather than claiming an outcome", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "Only an admin", code: "42501" } });
    await expect(setRoleCapabilities("mod@example.com", [])).rejects.toMatchObject({ status: 403, code: "42501" });
  });

  it("revokes by email", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });

    await revokeRole("mod@example.com");

    expect(lastCall("findback_role_revoke").args).toEqual({ p_email: "mod@example.com" });
  });

  it("maps the audit log rows", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          id: "a1",
          actor_user_id: "u1",
          action: "ROLE_GRANTED",
          target_type: "user_roles",
          target_id: "u2",
          reason: "hired",
          previous_state: null,
          new_state: { role: "MODERATOR" },
          created_at: "2026-10-22T00:00:00.000Z",
        },
      ],
      error: null,
    });

    const entries = await readAuditLog(25);

    expect(entries.at(0)?.action).toBe("ROLE_GRANTED");
    expect(entries.at(0)?.newState).toEqual({ role: "MODERATOR" });
    expect(lastCall("findback_audit_log").args).toEqual({ p_limit: 25 });
  });

  it("refuses the last-admin revocation with the server's own answer", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "The last admin cannot be revoked", code: "42501" },
    });

    await expect(revokeRole("admin@example.com")).rejects.toMatchObject({
      status: 403,
      message: "The last admin cannot be revoked",
    });
  });
});

describe("bootstrapAdmin", () => {
  it("calls the one-time claim", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });

    await bootstrapAdmin();

    expect(lastCall("findback_bootstrap_admin").args).toEqual({});
  });

  it("surfaces the refusal when the account is not on the allowlist", async () => {
    clientMock.rpc.mockResolvedValue({
      data: null,
      error: { message: "This account is not in the admin bootstrap list", code: "42501" },
    });

    await expect(bootstrapAdmin()).rejects.toMatchObject({ status: 403 });
  });
});
