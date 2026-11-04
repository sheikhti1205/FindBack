// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  backup: {
    status: vi.fn(), promptDecision: vi.fn(), connect: vi.fn(), disable: vi.fn(),
    forget: vi.fn(), markDirty: vi.fn(), uploadNow: vi.fn(), restore: vi.fn(), tick: vi.fn(),
  },
  rotate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../services/messaging/backupRuntime", () => ({ driveBackup: () => mocks.backup, startDriveBackup: () => () => undefined }));
vi.mock("../services/messaging/backupKey", () => ({ rotateBackupKey: mocks.rotate }));
vi.mock("../services/messaging/runtime", () => ({ refreshMessaging: mocks.refresh }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "00000000-0000-4000-9a01-000000000001" } }) }));

import { BackupSettings, describeBackupTime } from "./BackupSettings";
import { DriveAuthError } from "../services/messaging/driveAuth";
import { ApiError } from "../services/session";

const NOW = 1_760_000_000_000;
const UP_TO_DATE = { kind: "up-to-date" as const, lastUploadAt: NOW };
const OFF = { kind: "off" as const };
const WAITING = { kind: "waiting" as const, nextAttemptAt: NOW };

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.backup.status.mockReturnValue(OFF);
  mocks.backup.connect.mockResolvedValue(UP_TO_DATE);
  mocks.backup.uploadNow.mockResolvedValue(UP_TO_DATE);
  mocks.backup.restore.mockResolvedValue({ messages: 3, manifest: {} });
  mocks.rotate.mockResolvedValue({ accountId: "a", generation: "b", keyHex: "c", createdAt: 1 });
  mocks.refresh.mockResolvedValue(undefined);
});

function renderScreen() {
  return render(<MemoryRouter><BackupSettings /></MemoryRouter>);
}

describe("the backup settings surface", () => {
  it("offers a connection when backup is off", () => {
    renderScreen();
    expect(screen.getByText("Google Drive backup")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore from Drive" })).toBeNull();
  });

  it("says plainly when the build cannot connect, without a dead button", () => {
    mocks.backup.status.mockReturnValue({ kind: "unavailable", reason: "native" });
    renderScreen();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(screen.getByText(/can't reach Google Drive/)).toBeTruthy();
    // Never claim the Android app lacks the feature: it has it natively now, and
    // this state is the build/device that cannot reach Google at all.
    expect(screen.queryByText(/in the Android app yet/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect Google Drive/ })).toBeNull();
  });

  it("connects and reports that backup is on", async () => {
    mocks.backup.connect.mockImplementation(async () => {
      mocks.backup.status.mockReturnValue(UP_TO_DATE);
      return UP_TO_DATE;
    });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(mocks.backup.connect).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId("backup-notice")).textContent)
      .toBe("Backup is on. Your chats are saved to your Google Drive.");
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("Last backed up just now.")).toBeTruthy();
  });

  it("shows the human reason when Google access is declined", async () => {
    mocks.backup.connect.mockRejectedValueOnce(new DriveAuthError("denied"));
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent)
      .toBe("Google Drive access was not granted.");
    expect(screen.queryByTestId("backup-notice")).toBeNull();
  });

  it("shows a removed installation's message instead of a retry loop", async () => {
    mocks.backup.connect.mockRejectedValueOnce(
      new ApiError("This device was removed from your account. Sign in again to use Chat.", 403));
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent)
      .toBe("This device was removed from your account. Sign in again to use Chat.");
  });

  it("backs up on demand and restores into chat", async () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(mocks.backup.uploadNow).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId("backup-notice")).textContent).toBe("Your chats are backed up.");

    fireEvent.click(screen.getByRole("button", { name: "Restore from Drive" }));
    await waitFor(() => expect(mocks.backup.restore).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId("backup-notice")).textContent)
      .toBe("Restored 3 messages. Chat is catching up.");
    expect(mocks.refresh).toHaveBeenCalledWith("00000000-0000-4000-9a01-000000000001");
  });

  it("turns automatic backup off without disconnecting Drive", () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    renderScreen();
    fireEvent.click(screen.getByRole("switch", { name: "Back up automatically" }));
    expect(mocks.backup.disable).toHaveBeenCalledTimes(1);
    expect(mocks.backup.forget).not.toHaveBeenCalled();
    expect(screen.getByTestId("backup-notice").textContent).toBe("Automatic backup is off.");
  });

  it("disconnects only after an explicit second confirmation", () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Google Drive…" }));
    expect(mocks.backup.forget).not.toHaveBeenCalled();
    expect(screen.getByText(/Existing backups stay in your Drive/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(mocks.backup.forget).toHaveBeenCalledTimes(1);
  });

  it("replaces the key only after confirming the consequence", async () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Replace backup key…" }));
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(screen.getByText(/Older backups can no longer be opened/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(mocks.rotate).toHaveBeenCalledTimes(1));
    expect(mocks.backup.markDirty).toHaveBeenCalledTimes(1);
    expect(mocks.backup.uploadNow).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("backup-notice")).textContent)
      .toBe("A new backup key was created. Older backups can no longer be opened.");
  });

  it("keeps the switch on when reconnect is required", () => {
    mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "auth" });
    renderScreen();
    expect(screen.getByRole("button", { name: "Reconnect Google Drive" })).toBeTruthy();
    // Nothing is uploading right now, so no switch or restore is offered.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore from Drive" })).toBeNull();
  });

  it("describes recency without exact timestamps", () => {
    expect(describeBackupTime(NOW, NOW)).toBe("just now");
    expect(describeBackupTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(describeBackupTime(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(describeBackupTime(NOW - 3 * 60 * 60_000, NOW)).toBe("3 hours ago");
    expect(describeBackupTime(NOW - 25 * 60 * 60_000, NOW)).toBe("yesterday");
    expect(describeBackupTime(NOW - 4 * 24 * 60 * 60_000, NOW)).toBe("4 days ago");
    expect(describeBackupTime(NOW + 60_000, NOW)).toBe("just now");
  });

  it("waits rather than claiming a pass it has not run", () => {
    mocks.backup.status.mockReturnValue(WAITING);
    renderScreen();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByText("Changes are backed up automatically while you use Chat.")).toBeTruthy();
  });
});
