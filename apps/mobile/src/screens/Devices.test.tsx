// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { mockListDevices, mockRenameDevice, mockRemoveDevice } = vi.hoisted(() => ({
  mockListDevices: vi.fn(),
  mockRenameDevice: vi.fn(),
  mockRemoveDevice: vi.fn(),
}));

vi.mock("../services/devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/devices")>();
  return {
    ...actual,
    listDevices: (...args: unknown[]) => mockListDevices(...args),
    renameDevice: (...args: unknown[]) => mockRenameDevice(...args),
    removeDevice: (...args: unknown[]) => mockRemoveDevice(...args),
  };
});

import { Devices } from "./Devices";
import { ApiError } from "../services/session";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const phone = { deviceId: id(1), name: "My phone", platform: "android",
  lastSeenAt: Date.now() - 60_000, current: true };
const tablet = { deviceId: id(2), name: "Old tablet", platform: "web",
  lastSeenAt: Date.now() - 3 * 24 * 60 * 60_000, current: false };

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockListDevices.mockResolvedValue([phone, tablet]);
  mockRenameDevice.mockResolvedValue(undefined);
  mockRemoveDevice.mockResolvedValue(undefined);
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
  );
}

describe("the devices signed in to an account", () => {
  it("shows a friendly name, the platform and recency, marking this device", async () => {
    renderScreen();
    expect(await screen.findByRole("button", { name: "My phone" })).toBeTruthy();
    expect(screen.getByText("Android · Active now")).toBeTruthy();
    expect(screen.getByText("Web browser · Last active 3 days ago")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
    // No identifier, token or cursor reaches the surface.
    expect(screen.queryByText(id(1))).toBeNull();
    expect(screen.queryByText(id(2))).toBeNull();
  });

  it("renames a device and tells the reader exactly what changed", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "My phone" }));
    const field = await screen.findByLabelText("Device name");
    fireEvent.change(field, { target: { value: "  Kitchen phone  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(mockRenameDevice).toHaveBeenCalledWith(id(1), "Kitchen phone"));
    expect((await screen.findByTestId("devices-notice")).textContent)
      .toBe("This device is now called Kitchen phone.");
    expect(await screen.findByRole("button", { name: "Kitchen phone" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Device name")).toBeNull());
  });

  it("cannot save an unchanged or blank name", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "My phone" }));
    const save = await screen.findByRole("button", { name: "Save name" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const field = screen.getByLabelText("Device name");
    fireEvent.change(field, { target: { value: "   " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "My phone" } });
    expect(save.disabled).toBe(true);
    expect(mockRenameDevice).not.toHaveBeenCalled();
  });

  it("removes another device only after a second, explicit confirmation", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Old tablet" }));
    expect(screen.queryByRole("button", { name: "Remove device" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove device…" }));
    expect(screen.getByText(/stops receiving messages here/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove device" }));

    await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith(id(2)));
    expect((await screen.findByTestId("devices-notice")).textContent)
      .toBe("Old tablet was removed and signed out of Chat.");
    expect(screen.queryByRole("button", { name: "Old tablet" })).toBeNull();
    expect(screen.getByRole("button", { name: "My phone" })).toBeTruthy();
  });

  it("offers no removal for the device in use, only the sign-out pointer", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "My phone" }));
    await screen.findByLabelText("Device name");
    expect(screen.queryByRole("button", { name: "Remove device…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove device" })).toBeNull();
    expect(screen.getByText(/use Log out in Account/i)).toBeTruthy();
    expect(mockRemoveDevice).not.toHaveBeenCalled();
  });

  it("states the empty state instead of pretending a list exists", async () => {
    mockListDevices.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/Devices show up here after you use Chat on them/i)).toBeTruthy();
  });

  it("shows the failure, then recovers on retry", async () => {
    mockListDevices.mockRejectedValueOnce(new ApiError("Devices could not load. Try again.", 500));
    renderScreen();
    expect((await screen.findByTestId("devices-error")).textContent)
      .toBe("Devices could not load. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry devices" }));
    expect(await screen.findByRole("button", { name: "My phone" })).toBeTruthy();
    expect(screen.queryByTestId("devices-error")).toBeNull();
  });

  it("reports a refused rename inside the sheet and keeps the device usable", async () => {
    mockRenameDevice.mockRejectedValueOnce(new ApiError("That device could not be renamed. Try again.", 500));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Old tablet" }));
    fireEvent.change(await screen.findByLabelText("Device name"), { target: { value: "Spare tablet" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("That device could not be renamed. Try again.");
    expect(screen.getByLabelText("Device name")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Spare tablet 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(mockRenameDevice).toHaveBeenLastCalledWith(id(2), "Spare tablet 2"));
  });
});
