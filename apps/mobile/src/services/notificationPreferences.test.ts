import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fetchNotificationPreferences,
  mapPreferences,
  saveNotificationPreferences,
} from "./notificationPreferences";

const { clientMock } = vi.hoisted(() => ({ clientMock: { rpc: vi.fn() } }));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
});

describe("mapPreferences", () => {
  it("returns defaults when the user has no stored preferences", () => {
    expect(mapPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("coerces integer flags to booleans", () => {
    expect(
      mapPreferences({
        push_enabled: 1,
        likes: 0,
        comments: 1,
        mentions: 0,
        status: 1,
      }),
    ).toEqual({ pushEnabled: true, likes: false, comments: true, mentions: false, status: true });
  });
});

describe("fetchNotificationPreferences", () => {
  it("reads the first row of the RPC result", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ push_enabled: 0, likes: 1, comments: 1, mentions: 1, status: 0 }],
      error: null,
    });
    expect(await fetchNotificationPreferences()).toEqual({
      pushEnabled: false,
      likes: true,
      comments: true,
      mentions: true,
      status: false,
    });
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_get_notification_preferences_client", {});
  });

  it("falls back to defaults when the RPC returns no rows", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});

describe("saveNotificationPreferences", () => {
  it("sends every category flag to the setter RPC", async () => {
    clientMock.rpc.mockResolvedValue({ error: null });
    await saveNotificationPreferences({
      pushEnabled: true,
      likes: false,
      comments: true,
      mentions: true,
      status: false,
    });
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_set_notification_preferences_client", {
      p_push_enabled: true,
      p_likes: false,
      p_comments: true,
      p_mentions: true,
      p_status: false,
    });
  });

  it("maps an auth failure to 401", async () => {
    clientMock.rpc.mockResolvedValue({ error: { message: "Not authenticated", code: "28000" } });
    await expect(
      saveNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES),
    ).rejects.toMatchObject({ status: 401 });
  });
});
