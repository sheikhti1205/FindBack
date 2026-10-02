import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDeviceToken, unregisterDeviceToken } from "./deviceTokens";

const { clientMock } = vi.hoisted(() => ({ clientMock: { rpc: vi.fn() } }));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
});

describe("registerDeviceToken", () => {
  it("sends the token and platform to the client RPC", async () => {
    clientMock.rpc.mockResolvedValue({ error: null });
    await registerDeviceToken("fcm-token-123", "android");
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_register_device_token_client", {
      p_token: "fcm-token-123",
      p_platform: "android",
    });
  });

  it("maps a rejected token to 422", async () => {
    clientMock.rpc.mockResolvedValue({ error: { message: "Invalid device token", code: "22023" } });
    await expect(registerDeviceToken("x", "android")).rejects.toMatchObject({ status: 422 });
  });
});

describe("unregisterDeviceToken", () => {
  it("returns the number of removed tokens", async () => {
    clientMock.rpc.mockResolvedValue({ data: 1, error: null });
    expect(await unregisterDeviceToken("fcm-token-123")).toBe(1);
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_unregister_device_token_client", {
      p_token: "fcm-token-123",
    });
  });

  it("maps an auth failure to 401", async () => {
    clientMock.rpc.mockResolvedValue({ error: { message: "Not authenticated", code: "28000" } });
    await expect(unregisterDeviceToken("t")).rejects.toMatchObject({ status: 401 });
  });
});
