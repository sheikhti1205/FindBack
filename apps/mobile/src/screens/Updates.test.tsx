// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Updates } from "./Updates";
import type { UpdateSnapshot } from "../services/updates/controller";
import type { AndroidRelease } from "../services/updates/types";

const runtime = vi.hoisted(() => ({
  snapshot: null as UpdateSnapshot | null,
  native: false,
  checkForUpdates: vi.fn(),
  refreshInstalledUpdates: vi.fn(),
  setUpdatePopupEnabled: vi.fn(),
  dismissUpdate: vi.fn(),
  markUpdateRead: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => runtime.native },
}));

vi.mock("../services/updates/runtime", () => ({
  useUpdateSnapshot: () => runtime.snapshot,
  checkForUpdates: runtime.checkForUpdates,
  refreshInstalledUpdates: runtime.refreshInstalledUpdates,
  setUpdatePopupEnabled: runtime.setUpdatePopupEnabled,
  dismissUpdate: runtime.dismissUpdate,
  markUpdateRead: runtime.markUpdateRead,
}));

function release(overrides: Partial<AndroidRelease> = {}): AndroidRelease {
  return {
    id: "v0.15.0-beta.1",
    platform: "android",
    versionName: "0.15.0-beta.1",
    versionCode: 15001,
    gitSha: "a".repeat(40),
    tag: "v0.15.0-beta.1",
    publishedAt: "2026-11-04T00:00:00Z",
    summary: "Faster search and clearer failure messages.",
    accepted: true,
    artifacts: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    installed: null,
    eligible: null,
    pending: null,
    popupEnabled: false,
    dismissed: [],
    lastCheck: null,
    history: [],
    idle: true,
    checking: false,
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/settings/updates"]}>
      <Updates />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  runtime.refreshInstalledUpdates.mockImplementation(async () => runtime.snapshot);
  runtime.checkForUpdates.mockImplementation(async () => runtime.snapshot);
});

afterEach(() => {
  cleanup();
  runtime.snapshot = null;
  runtime.native = false;
  runtime.checkForUpdates.mockReset();
  runtime.refreshInstalledUpdates.mockReset();
  runtime.setUpdatePopupEnabled.mockReset();
  runtime.dismissUpdate.mockReset();
  runtime.markUpdateRead.mockReset();
});

describe("updates screen", () => {
  it("does not call an unverifiable native installation up to date after a successful check", () => {
    runtime.native = true;
    runtime.snapshot = snapshot({ lastCheck: { attemptedAt: 2_000, status: "ok", checkedAt: 1_000 } });
    renderScreen();
    expect(screen.queryByText("Up to date")).toBeNull();
    expect(screen.getByText("Version unavailable")).toBeTruthy();
  });
  it("says plainly that a web build has nothing to install", () => {
    runtime.snapshot = snapshot();
    renderScreen();
    expect(screen.getByTestId("updates-installed").textContent).toBe("Web build");
    expect(screen.getByText(/Web updates are deployed automatically/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Updates & version history" })).toBeTruthy();
  });

  it("shows the installed build on a device that can prove it", () => {
    runtime.native = true;
    runtime.snapshot = snapshot({
      installed: {
        packageName: "com.findback.app",
        versionCode: 14001,
        signingChannel: "beta",
        abi: "arm64-v8a",
        sdk: 35,
      },
      lastCheck: { attemptedAt: 2_000, status: "ok", checkedAt: 1_000 },
    });
    renderScreen();
    expect(screen.getByTestId("updates-installed").textContent).toContain("build 14001");
    expect(screen.getByText("No compatible update")).toBeTruthy();
  });

  it("does not pretend a build it cannot verify is current", () => {
    runtime.native = true;
    runtime.snapshot = snapshot();
    renderScreen();
    expect(screen.getByTestId("updates-installed").textContent).toBe(
      "This build can't confirm its own version",
    );
    expect(screen.getByText("Not checked yet")).toBeTruthy();
  });

  it("reports a failed check as a failure, with a retry path", () => {
    runtime.snapshot = snapshot({
      lastCheck: { attemptedAt: 5_000, status: "error", code: "offline", checkedAt: 4_000 },
    });
    renderScreen();
    expect(screen.getByText("Couldn't check")).toBeTruthy();
    expect(screen.getByText(/No connection\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });

  it("shows an eligible release and a history that distinguishes its states", () => {
    runtime.native = true;
    runtime.snapshot = snapshot({
      installed: {
        packageName: "com.findback.app",
        versionCode: 15001,
        signingChannel: "beta",
        abi: "arm64-v8a",
        sdk: 35,
      },
      eligible: release(),
      lastCheck: { attemptedAt: 2_000, status: "ok", checkedAt: 1_000 },
      history: [
        release(),
        release({
          id: "v0.10.0-beta.1",
          versionName: "0.10.0-beta.1",
          versionCode: 10_050,
          tag: "v0.10.0-beta.1",
          artifacts: [],
        }),
        release({
          id: "v0.9.0-beta.1",
          versionName: "0.9.0-beta.1",
          versionCode: 10_047,
          tag: "v0.9.0-beta.1",
          artifacts: [
            {
              url: "https://github.com/sheikhti1205/Norfold/releases/download/v0.9.0-beta.1/x.apk",
              bytes: 1,
              sha256: "1".repeat(64),
              packageName: "com.findback.app",
              signingChannel: "beta",
              signerSha256: "ab".repeat(32),
              abis: ["arm64-v8a"],
              minSdk: 24,
              targetSdk: 36,
            },
          ],
        }),
      ],
    });
    renderScreen();
    expect(screen.getByTestId("updates-eligible").textContent).toContain("0.15.0-beta.1");
    const items = screen.getAllByTestId("updates-history-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Installed");
    // An assetless tag says so instead of offering bytes that do not exist.
    expect(items[1]!.textContent).toContain("No files published");
    expect(items[1]!.textContent).toContain("announcement");
    // A normal older release carries no state pill: it is neither installed,
    // eligible, empty nor unaccepted.
    expect(items[2]!.querySelector(".fb-status-pill")).toBeNull();
  });

  it("keeps notices off by default and only changes on an explicit choice", () => {
    runtime.snapshot = snapshot();
    renderScreen();
    const toggle = screen.getByRole("switch", { name: /Show update notices/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(runtime.setUpdatePopupEnabled).toHaveBeenCalledWith(true);
  });

  it("checks on demand", () => {
    runtime.snapshot = snapshot();
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(runtime.checkForUpdates).toHaveBeenCalled();
  });

  it("marks a release as seen when the reader opens this screen", () => {
    runtime.snapshot = snapshot({ history: [release()], popupEnabled: false });
    renderScreen();
    expect(runtime.markUpdateRead).toHaveBeenCalledWith("v0.15.0-beta.1");
    expect(runtime.dismissUpdate).not.toHaveBeenCalled();
  });

  it("shows an honest empty history instead of a blank gap", () => {
    runtime.snapshot = snapshot();
    renderScreen();
    expect(screen.getByTestId("updates-history-empty")).toBeTruthy();
  });
});
