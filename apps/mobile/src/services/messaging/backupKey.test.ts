import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBackupKey, rotateBackupKey } from "./backupKey";
import { ApiError } from "../session";

const { clientMock } = vi.hoisted(() => ({ clientMock: { rpc: vi.fn() } }));
vi.mock("../supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

const A = "00000000-0000-4000-9e01-000000000001";
const GEN = "00000000-0000-4000-9e01-000000000002";
const KEY = "ab".repeat(32);
const row = { accountId: A, generation: GEN, key: KEY, createdAt: 1_760_000_000_000 };

beforeEach(() => { clientMock.rpc.mockReset(); });

describe("the account backup key", () => {
  it("reads exactly the key material the client needs", async () => {
    clientMock.rpc.mockResolvedValue({ data: row, error: null });
    await expect(readBackupKey()).resolves.toEqual({
      accountId: A, generation: GEN, keyHex: KEY, createdAt: 1_760_000_000_000,
    });
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_backup_key", { p_action: "READ", p_args: {} });
  });

  it("rotates through its own action and never reuses the read path", async () => {
    clientMock.rpc.mockResolvedValue({ data: row, error: null });
    await rotateBackupKey();
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_backup_key", { p_action: "ROTATE", p_args: {} });
  });

  it("refuses a projection that is not exactly the four fields", async () => {
    const cases: unknown[] = [
      null,
      [],
      "key",
      { ...row, extra: "" },
      { accountId: A, generation: GEN, key: KEY },
      { ...row, key: "AB".repeat(32) },
      { ...row, key: KEY.slice(2) },
      { ...row, key: `${KEY}\n` },
      { ...row, generation: "not-a-uuid" },
      { ...row, accountId: "nope" },
      { ...row, createdAt: 0 },
      { ...row, createdAt: 1.5 },
    ];
    for (const data of cases) {
      clientMock.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(readBackupKey(), JSON.stringify(data)?.slice(0, 40))
        .rejects.toMatchObject({ message: "Backup is unavailable right now. Try again." });
    }
  });

  it("tells a removed installation why it cannot read the key", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    const error = await readBackupKey().catch((err: unknown) => err as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message)
      .toBe("This device was removed from your account. Sign in again to use Chat.");
  });

  it("maps every other refusal to human backup copy without server text", async () => {
    for (const [code, status] of [["28000", 401], ["22023", 429], ["54000", 429], ["XX000", 500]] as const) {
      clientMock.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "postgres detail" } });
      const error = await readBackupKey().catch((err: unknown) => err as ApiError);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).message).not.toMatch(/postgres|rpc|detail/i);
    }
  });
});
