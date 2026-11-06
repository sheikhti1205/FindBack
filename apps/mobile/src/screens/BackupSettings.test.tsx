// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  backup: {
    subscribe: vi.fn(),
    status: vi.fn(), promptDecision: vi.fn(), connect: vi.fn(), disable: vi.fn(),
    forget: vi.fn(), markDirty: vi.fn(), uploadNow: vi.fn(), restore: vi.fn(), tick: vi.fn(),
  },
  rotate: vi.fn(),
  refresh: vi.fn(),
  listeners: new Set<() => void>(),
  accountId: "00000000-0000-4000-9a01-000000000001",
  authSessionId: "synthetic-session-a",
}));

vi.mock("../services/messaging/backupRuntime", () => ({ driveBackup: () => mocks.backup, startDriveBackup: () => () => undefined }));
vi.mock("../services/messaging/backupKey", () => ({ rotateBackupKey: mocks.rotate }));
vi.mock("../services/messaging/runtime", () => ({ refreshMessaging: mocks.refresh }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: mocks.accountId }, authSessionId: mocks.authSessionId }) }));

import { BackupSettings, describeBackupTime } from "./BackupSettings";

const NOW = 1_760_000_000_000;
const UP_TO_DATE = { kind: "up-to-date" as const, lastUploadAt: NOW, enabled: true };
const COMMITTED = { kind: "committed" as const, lastUploadAt: NOW, snapshotRevision: 1 };
const OFF = { kind: "off" as const, enabled: false };
const WAITING = { kind: "waiting" as const, nextAttemptAt: NOW, enabled: true };

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountId = "00000000-0000-4000-9a01-000000000001";
  mocks.authSessionId = "synthetic-session-a";
  mocks.listeners.clear();
  mocks.backup.subscribe.mockImplementation((listener: () => void) => {
    mocks.listeners.add(listener); return () => mocks.listeners.delete(listener);
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.backup.status.mockReturnValue(OFF);
  mocks.backup.disable.mockReturnValue(true);
  mocks.backup.connect.mockResolvedValue(COMMITTED);
  mocks.backup.uploadNow.mockResolvedValue(COMMITTED);
  mocks.backup.restore.mockResolvedValue({ kind: "restored", messages: 3, manifest: {} });
  mocks.rotate.mockResolvedValue({ accountId: "a", generation: "b", keyHex: "c", createdAt: 1 });
  mocks.refresh.mockResolvedValue(undefined);
});

function renderScreen() {
  return render(<MemoryRouter><BackupSettings /></MemoryRouter>);
}

describe("the backup settings surface", () => {
  it("names a Drive rejection without blaming the connection", async () => {
    mocks.backup.status.mockReturnValue(WAITING);
    mocks.backup.uploadNow.mockResolvedValue({ kind: "failed", reason: "provider" });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect((await screen.findByTestId("backup-error")).textContent).toContain("Google Drive rejected");
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  it("keeps fixed-label failure details behind a closed diagnostics disclosure", () => {
    mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "provider", enabled: true,
      diagnostic: { stage: "drive-list", cause: "invalid" } });
    renderScreen();
    const disclosure = screen.getByText("Backup diagnostics").closest("details")!;
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain("drive-list / invalid");
  });

  it("keeps disconnect available as a compact named icon action", () => {
    mocks.backup.status.mockReturnValue(WAITING);
    renderScreen();
    const disconnect = screen.getByRole("button", { name: "Disconnect Google Drive…" });
    expect(disconnect.querySelector("svg")).toBeTruthy();
    expect(disconnect.textContent).not.toContain("Disconnect Google Drive");
  });

  it.each(["account", "session"])("drops late restore notices and HEAD work after %s changes", async change => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    let resolve!: (value: unknown) => void;
    mocks.backup.restore.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Restore from Drive" }));
    if (change === "account") mocks.accountId = "00000000-0000-4000-9a01-000000000002";
    else mocks.authSessionId = "synthetic-session-b";
    view.rerender(<MemoryRouter><BackupSettings /></MemoryRouter>);
    await act(async () => { resolve({ kind: "restored", messages: 3, manifest: {} }); });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("backup-notice")).toBeNull();
  });

  it("offers a connection when backup is off", () => {
    renderScreen();
    expect(screen.getByText("Google Drive backup")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore from Drive" })).toBeNull();
  });

  it("says plainly when the build cannot connect, without a dead button", () => {
    mocks.backup.status.mockReturnValue({ kind: "unavailable", reason: "native", enabled: false });
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
      return COMMITTED;
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
    mocks.backup.connect.mockResolvedValueOnce({ kind: "needs-connection", enabled: false });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent)
      .toBe("Reconnect Google Drive, then try again.");
    expect(screen.queryByTestId("backup-notice")).toBeNull();
  });

  it("updates a mounted screen when a background pass loses its connection", async () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE); renderScreen();
    act(() => {
      mocks.backup.status.mockReturnValue({ kind: "needs-connection", enabled: true });
      for (const listener of mocks.listeners) listener();
    });
    expect(await screen.findByRole("button", { name: "Reconnect Google Drive" })).toBeTruthy();
    expect(screen.queryByText("Up to date")).toBeNull();
  });

  it("does not promise the first backup will finish after a failed connect pass", async () => {
    mocks.backup.connect.mockResolvedValue({ kind: "failed", reason: "offline" }); renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent).toContain("didn't finish");
    expect(screen.queryByTestId("backup-notice")).toBeNull();
  });

  it("does not claim restored chat caught up when HEAD reconciliation fails", async () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    mocks.refresh.mockRejectedValueOnce(new Error("synthetic HEAD offline")); renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Restore from Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent).toContain("catch up");
    expect(screen.queryByTestId("backup-notice")).toBeNull();
  });

  it("shows a removed installation's message instead of a retry loop", async () => {
    mocks.backup.connect.mockResolvedValueOnce({ kind: "failed", reason: "account" });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByTestId("backup-error")).textContent)
      .toBe("This device can't use the backup key. Sign in again; if this device was removed, add it again.");
    expect(screen.queryByText(/Check your connection/)).toBeNull();
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

  it("does not announce off after failed durable opt-out and explains the session-only pause", () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    mocks.backup.disable.mockImplementationOnce(() => {
      mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "storage", enabled: true, optOutPending: true });
      return false;
    });
    renderScreen();
    fireEvent.click(screen.getByRole("switch", { name: "Back up automatically" }));
    expect(screen.queryByTestId("backup-notice")).toBeNull();
    expect(screen.getByText(/Automatic backup is paused on this device/)).toBeTruthy();
    expect(screen.getByTestId("backup-error").textContent).toContain("before reopening");
    expect(screen.getByRole("switch", { name: "Back up automatically" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
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

  it("does not offer a consumer key replacement that would orphan backups", () => {
    mocks.backup.status.mockReturnValue(UP_TO_DATE);
    renderScreen();
    expect(screen.queryByRole("button", { name: /Replace backup key/ })).toBeNull();
    expect(screen.queryByText(/Older backups can no longer be opened/)).toBeNull();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it("pauses instead of offering controls that cannot work on an unreadable backup", () => {
    mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "integrity", enabled: true });
    renderScreen();
    expect(screen.getByText(/Backup is paused so the copy already in your Drive stays intact/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore from Drive" })).toBeNull();
    // Disabling and disconnecting must stay possible.
    expect(screen.getByRole("switch", { name: "Back up automatically" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Google Drive…" })).toBeTruthy();
  });

  it("keeps the switch on when the opt-out could not be saved", () => {
    // The durable policy is still enabled after a denied write: claiming "off"
    // here would hide the upload that resumes on the next launch.
    mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "storage", enabled: true });
    renderScreen();
    const toggle = screen.getByRole("switch", { name: "Back up automatically" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Check available storage/)).toBeTruthy();
  });

  it("keeps the switch on when reconnect is required", () => {
    mocks.backup.status.mockReturnValue({ kind: "attention", lastError: "auth", enabled: true });
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
    expect(screen.getByText(/Changes are backed up while Norfold is open/)).toBeTruthy();
  });
});
