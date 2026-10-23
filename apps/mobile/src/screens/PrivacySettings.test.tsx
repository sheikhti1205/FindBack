// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { enabledMock, requestEnableMock, nativeAvailableMock } = vi.hoisted(() => ({
  enabledMock: vi.fn(),
  requestEnableMock: vi.fn(),
  nativeAvailableMock: vi.fn(),
}));

vi.mock("../services/locationServices", () => ({
  isDeviceLocationEnabled: enabledMock,
  requestEnableDeviceLocation: requestEnableMock,
  isNativeLocationServicesAvailable: nativeAvailableMock,
}));

import { isDiagEnabled, setDiagEnabled } from "../services/diag";
import { PrivacySettings } from "./PrivacySettings";

beforeEach(() => {
  enabledMock.mockReset();
  requestEnableMock.mockReset();
  nativeAvailableMock.mockReset();
  nativeAvailableMock.mockReturnValue(true);
  setDiagEnabled(false);
});

afterEach(cleanup);

function renderPrivacy() {
  return render(
    <MemoryRouter>
      <PrivacySettings />
    </MemoryRouter>,
  );
}

/** Scope status assertions to the Location group; other rows also use pills. */
async function locationGroup() {
  const heading = await screen.findByRole("heading", { name: "Location" });
  const group = heading.closest("section");
  if (!group) throw new Error("Location group not found");
  return within(group);
}

describe("PrivacySettings", () => {
  it("links blocked accounts and report receipts from the safety section", () => {
    renderPrivacy();
    const safety = screen.getByRole("region", { name: "Safety" });
    expect(within(safety).getByRole("link", { name: /Blocked accounts/i }).getAttribute("href")).toBe("/settings/privacy/blocked");
    expect(within(safety).getByRole("link", { name: /Your safety reports/i }).getAttribute("href")).toBe("/settings/privacy/reports");
  });

  it("renders one h1 backed to /settings and shows the real location state", async () => {
    enabledMock.mockResolvedValue(true);
    renderPrivacy();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await (await locationGroup()).findByText("On")).toBeTruthy();
    expect(screen.queryByText(/precise location/i)).toBeNull();
  });

  it("offers the real enable-location action and refreshes status", async () => {
    enabledMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    requestEnableMock.mockResolvedValue(true);
    renderPrivacy();

    const location = await locationGroup();
    fireEvent.click(await screen.findByRole("button", { name: /turn on location services/i }));
    await waitFor(() => expect(requestEnableMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(location.getByText("On")).toBeTruthy());
  });

  it("says honestly when location state is unknown", async () => {
    enabledMock.mockResolvedValue(null);
    renderPrivacy();

    expect(await screen.findByText(/not available on this device/i)).toBeTruthy();
  });

  it("toggles the real verbose-logging flag and links AI privacy to its screen", async () => {
    enabledMock.mockResolvedValue(null);
    renderPrivacy();

    const logging = await screen.findByRole("switch", { name: /verbose diagnostic logging/i });
    expect(logging.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(logging);
    expect(isDiagEnabled()).toBe(true);
    expect(logging.getAttribute("aria-checked")).toBe("true");

    expect(screen.getByRole("link", { name: /ai privacy/i }).getAttribute("href")).toBe("/settings/ai/privacy");
    expect(screen.getByRole("heading", { name: /crash reports/i })).toBeTruthy();
  });
});
