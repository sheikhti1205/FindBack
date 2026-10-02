// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { permissionMock, startMock, openSettingsMock } = vi.hoisted(() => ({
  permissionMock: vi.fn(),
  startMock: vi.fn(),
  openSettingsMock: vi.fn(),
}));

vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({
    permission: permissionMock,
    start: startMock,
    openSettings: openSettingsMock,
  }),
}));

vi.mock("../services/notificationPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notificationPreferences")>();
  return {
    ...actual,
    fetchNotificationPreferences: vi.fn(async () => ({
      pushEnabled: true,
      likes: true,
      comments: true,
      mentions: true,
      status: true,
    })),
    saveNotificationPreferences: vi.fn(async () => {}),
  };
});

import { NotificationSettings } from "./NotificationSettings";

beforeEach(() => {
  permissionMock.mockReset();
  startMock.mockReset();
  openSettingsMock.mockReset();
});

afterEach(cleanup);

describe("NotificationSettings device permission", () => {
  it("explains before prompting and requests on tap when undetermined", async () => {
    permissionMock.mockResolvedValue("prompt");
    startMock.mockResolvedValue("granted");
    render(<NotificationSettings />);

    const button = await screen.findByRole("button", { name: /enable device notifications/i });
    expect(startMock).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/device notifications are on/i)).toBeTruthy();
  });

  it("offers the OS settings recovery path after a denial", async () => {
    permissionMock.mockResolvedValue("denied");
    render(<NotificationSettings />);

    const button = await screen.findByRole("button", { name: /open notification settings/i });
    fireEvent.click(button);
    await waitFor(() => expect(openSettingsMock).toHaveBeenCalledTimes(1));
  });

  it("shows nothing device-specific on the web", async () => {
    permissionMock.mockResolvedValue("unsupported");
    render(<NotificationSettings />);

    await screen.findByRole("switch", { name: "Push notifications" });
    expect(screen.queryByRole("button", { name: /device notifications/i })).toBeNull();
  });
});
