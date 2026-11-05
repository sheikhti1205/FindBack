// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  backup: {
    promptDecision: vi.fn(),
    connect: vi.fn(),
    dismissPrompt: vi.fn(),
  },
  announce: vi.fn(),
}));

vi.mock("../services/messaging/backupRuntime", () => ({ driveBackup: () => mocks.backup }));
vi.mock("./LiveRegion", () => ({ announce: mocks.announce }));

import { BackupPrompt } from "./BackupPrompt";
import { DriveAuthError } from "../services/messaging/driveAuth";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backup.promptDecision.mockReturnValue("show");
  mocks.backup.connect.mockResolvedValue({ kind: "up-to-date", lastUploadAt: 1 });
});

function renderPrompt(sequences = 4) {
  return render(<MemoryRouter><BackupPrompt sequences={sequences} /></MemoryRouter>);
}

describe("the one backup prompt", () => {
  it("stays out of the way until a decision is actually due", () => {
    mocks.backup.promptDecision.mockReturnValue(null);
    renderPrompt(0);
    expect(screen.queryByText("Keep your conversations with you")).toBeNull();
  });

  it("says where the key lives instead of implying nobody else can read it", () => {
    renderPrompt();
    expect(screen.getByText("Keep your conversations with you")).toBeTruthy();
    expect(screen.getByText(/your Norfold account holds the key/i)).toBeTruthy();
    // The backend re-issues the key, so "only your account can open them" is
    // false and must not come back.
    expect(screen.queryByText(/Only your account can open them/)).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeTruthy();
  });

  it("remembers 'Not now' and gets out of the way", () => {
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(mocks.backup.dismissPrompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Keep your conversations with you")).toBeNull();
  });

  it("connects, announces success once and disappears", async () => {
    mocks.backup.connect.mockResolvedValue({ kind: "committed", lastUploadAt: 1, snapshotRevision: 1 });
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(mocks.backup.connect).toHaveBeenCalledTimes(1));
    expect(mocks.announce).toHaveBeenCalledWith(
      "Backup is on. Your chats are saved to your Google Drive.");
    expect(screen.queryByText("Keep your conversations with you")).toBeNull();
  });

  it("keeps the prompt and reports honestly when the first pass does not commit", async () => {
    mocks.backup.connect.mockResolvedValue({ kind: "failed", reason: "offline" });
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByRole("alert")).textContent).toContain("didn't finish");
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(screen.getByText("Keep your conversations with you")).toBeTruthy();
  });

  it("keeps the prompt and shows the human reason when Drive is declined", async () => {
    mocks.backup.connect.mockRejectedValueOnce(new DriveAuthError("denied"));
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("Google Drive access was not granted.");
    expect(screen.getByText("Keep your conversations with you")).toBeTruthy();
    expect(mocks.backup.dismissPrompt).not.toHaveBeenCalled();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it("uses plain language for an unexpected failure", async () => {
    mocks.backup.connect.mockRejectedValueOnce(new Error("boom"));
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect((await screen.findByRole("alert")).textContent)
      .toBe("Google Drive could not be connected. Try again.");
  });

  it("offers the settings surface as a quiet escape hatch", () => {
    renderPrompt();
    expect(screen.getByRole("link", { name: "Backup settings" }).getAttribute("href"))
      .toBe("/settings/backup");
  });
});
