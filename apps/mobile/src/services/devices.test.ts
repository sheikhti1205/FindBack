import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeDeviceActivity,
  describeDevicePlatform,
  listDevices,
  removeDevice,
  renameDevice,
} from "./devices";
import { ApiError } from "./session";

const { clientMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const now = 1_700_000_000_000;

function row(n: number, overrides: Record<string, unknown> = {}) {
  return { deviceId: id(n), name: `Device ${n}`, platform: "android",
    lastSeenAt: now - 60_000, current: false, ...overrides };
}

function call(name: string): Record<string, unknown> {
  const entry = clientMock.rpc.mock.calls.find((value) => value[0] === name);
  expect(entry, `${name} was called`).toBeTruthy();
  return entry![1] as Record<string, unknown>;
}

beforeEach(() => {
  clientMock.rpc.mockReset();
});

describe("the account's signed-in devices", () => {
  it("reads the friendly rows and keeps exactly the server's order", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [row(1, { current: true, platform: null, name: "My phone" }), row(2, { platform: "web" })],
      error: null,
    });
    await expect(listDevices()).resolves.toEqual([
      { deviceId: id(1), name: "My phone", platform: null, lastSeenAt: now - 60_000, current: true },
      { deviceId: id(2), name: "Device 2", platform: "web", lastSeenAt: now - 60_000, current: false },
    ]);
    expect(call("findback_devices")).toEqual({ p_action: "LIST", p_args: {} });
  });

  it("treats an empty list as a real state, not a failure", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    await expect(listDevices()).resolves.toEqual([]);
  });

  it("refuses duplicate, half-valid or multi-current listings", async () => {
    const cases: unknown[] = [
      "not a list",
      [row(1), row(1)],
      [row(1, { current: true }), row(2, { current: true })],
      [row(1), { ...row(2), name: "" }],
      [row(1), { ...row(2), extra: "leak" }],
      [row(1), { ...row(2), lastSeenAt: -1 }],
      [row(1), { ...row(2), platform: "x".repeat(33) }],
      [row(1), { ...row(2), name: "hidden\u0000name" }],
      Array.from({ length: 65 }, (_, index) => row(index + 1)),
    ];
    for (const data of cases) {
      clientMock.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(listDevices(), JSON.stringify(data).slice(0, 40)).rejects.toThrow(
        "Devices could not load. Try again.",
      );
    }
  });

  it("never exposes anything beyond the five product fields", async () => {
    clientMock.rpc.mockResolvedValue({ data: [row(1, { current: true })], error: null });
    const [device] = await listDevices();
    expect(Object.keys(device!).sort()).toEqual(["current", "deviceId", "lastSeenAt", "name", "platform"]);
  });

  it("never claims this installation was removed when the list is refused", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "revoked" } });
    const error = await listDevices().catch((err: unknown) => err as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Devices could not load. Try again.");
    expect((error as ApiError).message).not.toMatch(/removed|sign in again/i);
  });

  it("asks for a fresh sign-in only when the account itself is unavailable", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { code: "28000", message: "no account" } });
    const error = await listDevices().catch((err: unknown) => err as ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe("Sign in again to see your devices.");
  });

  it("maps server refusals to human device errors", async () => {
    const cases: Array<[string, number]> = [["42501", 403], ["22023", 400], ["54000", 429], ["28000", 401]];
    for (const [code, status] of cases) {
      clientMock.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "server text" } });
      const error = await listDevices().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).message).not.toMatch(/server text|postgres|rpc/i);
    }
  });
});

describe("renaming and removing a device", () => {
  it("trims the name and sends only the device and its label", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    await renameDevice(id(2), "  Kitchen tablet  ");
    expect(call("findback_devices")).toEqual({
      p_action: "RENAME", p_args: { deviceId: id(2), name: "Kitchen tablet" },
    });
  });

  it("refuses a blank, overlong or control-character name without calling the server", async () => {
    for (const name of ["   ", "x".repeat(65), "bad\u0007name"]) {
      await expect(renameDevice(id(2), name)).rejects.toBeInstanceOf(ApiError);
    }
    await expect(renameDevice("not-a-uuid", "Kitchen")).rejects.toBeInstanceOf(ApiError);
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("removes another installation through REVOKE only", async () => {
    clientMock.rpc.mockResolvedValue({ data: true, error: null });
    await removeDevice(id(3));
    expect(call("findback_devices")).toEqual({ p_action: "REVOKE", p_args: { deviceId: id(3) } });
    await expect(removeDevice("nope")).rejects.toBeInstanceOf(ApiError);
  });

  it("keeps the operation's own sentence when the server refuses", async () => {
    clientMock.rpc.mockResolvedValue({ error: { code: "42501", message: "raw" } });
    await expect(removeDevice(id(3))).rejects.toThrow("That device could not be removed. Try again.");
    await expect(renameDevice(id(3), "Kitchen")).rejects.toThrow("That device could not be renamed. Try again.");
  });
});

describe("device copy", () => {
  it("names platforms in product language", () => {
    expect(describeDevicePlatform("android")).toBe("Android");
    expect(describeDevicePlatform("ios")).toBe("iPhone or iPad");
    expect(describeDevicePlatform("web")).toBe("Web browser");
    expect(describeDevicePlatform(null)).toBe("Norfold app");
    expect(describeDevicePlatform("something-new")).toBe("Norfold app");
  });

  it("describes recency without exact timestamps or negative times", () => {
    expect(describeDeviceActivity(now, now)).toBe("Active now");
    expect(describeDeviceActivity(now - 60_000, now)).toBe("Active now");
    expect(describeDeviceActivity(now - 5 * 60_000, now)).toBe("Active 5 min ago");
    expect(describeDeviceActivity(now - 60 * 60_000, now)).toBe("Active 1 hour ago");
    expect(describeDeviceActivity(now - 3 * 60 * 60_000, now)).toBe("Active 3 hours ago");
    expect(describeDeviceActivity(now - 26 * 60 * 60_000, now)).toBe("Last active 1 day ago");
    expect(describeDeviceActivity(now - 5 * 24 * 60 * 60_000, now)).toBe("Last active 5 days ago");
    // Clock skew must not produce "Active -2 min ago".
    expect(describeDeviceActivity(now + 60_000, now)).toBe("Active now");
  });
});
