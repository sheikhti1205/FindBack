import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockUser, isBlockedWithMe, listMyBlocks, unblockUser } from "./blocks";

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

function lastCall(name: string): Record<string, unknown> {
  const call = clientMock.rpc.mock.calls.find((entry) => entry[0] === name);
  expect(call, `${name} was called`).toBeTruthy();
  return call![1] as Record<string, unknown>;
}

describe("the caller's own block list", () => {
  it("reads only the outgoing rows the server exposes", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        { blocked_user_id: "user-2", created_at: "2026-10-22T10:00:00.000Z" },
        { blocked_user_id: "user-3", created_at: "2026-10-21T09:00:00.000Z" },
      ],
      error: null,
    });

    await expect(listMyBlocks()).resolves.toEqual([
      { userId: "user-2", blockedAt: "2026-10-22T10:00:00.000Z" },
      { userId: "user-3", blockedAt: "2026-10-21T09:00:00.000Z" },
    ]);
    expect(lastCall("findback_my_blocks")).toEqual({});
  });

  it("drops a row the client cannot name instead of rendering an empty entry", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ blocked_user_id: "", created_at: "2026-10-22T10:00:00.000Z" }],
      error: null,
    });
    await expect(listMyBlocks()).resolves.toEqual([]);
  });

  it("carries the server's refusal as a real answer, not an empty list", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "Not authenticated", code: "28000" } });
    await expect(listMyBlocks()).rejects.toMatchObject({ status: 401, code: "28000" });
  });
});

describe("blocking", () => {
  it("sends the target and nothing else — no rated/blocked direction is ever named", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    await blockUser("  user-2  ");
    expect(lastCall("findback_block_user")).toEqual({ p_user_id: "user-2" });
  });

  it("refuses an empty target without a round trip", async () => {
    await expect(blockUser("   ")).rejects.toMatchObject({ status: 400, code: "MISSING_USER_ID" });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("maps the server's own refusals honestly", async () => {
    const cases: Array<[string, number]> = [
      ["42501", 403],
      ["22023", 400],
      ["28000", 401],
      ["P0002", 404],
      ["PGRST202", 500],
    ];
    for (const [code, status] of cases) {
      clientMock.rpc.mockResolvedValue({ data: null, error: { message: "refused", code } });
      await expect(blockUser("user-2")).rejects.toMatchObject({ status, code });
    }
  });
});

describe("unblocking", () => {
  it("reports that the pair is still hidden while a direction remains (D22)", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    await expect(unblockUser("user-2")).resolves.toEqual({ stillHidden: true });
    expect(lastCall("findback_unblock_user")).toEqual({ p_user_id: "user-2" });
  });

  it("reports the pair restored only when the server says both directions are gone", async () => {
    clientMock.rpc.mockResolvedValue({ data: false, error: null });
    await expect(unblockUser("user-2")).resolves.toEqual({ stillHidden: false });
  });

  it("never rounds a missing answer up to 'restored'", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(unblockUser("user-2")).resolves.toEqual({ stillHidden: false });
  });
});

describe("the caller-scoped block bit", () => {
  it("is the server's boolean, and only a literal true counts", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    await expect(isBlockedWithMe("user-2")).resolves.toBe(true);
    expect(lastCall("findback_is_blocked_with_me")).toEqual({ p_other: "user-2" });

    clientMock.rpc.mockResolvedValue({ data: "true", error: null });
    await expect(isBlockedWithMe("user-2")).resolves.toBe(false);
  });

  it("carries a refusal rather than answering false", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "Not authenticated", code: "28000" } });
    await expect(isBlockedWithMe("user-2")).rejects.toMatchObject({ status: 401 });
  });
});
