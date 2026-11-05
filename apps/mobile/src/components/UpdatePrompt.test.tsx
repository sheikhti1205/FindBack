// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { UpdatePrompt } from "./UpdatePrompt";
import type { UpdateSnapshot } from "../services/updates/controller";
import type { AndroidRelease } from "../services/updates/types";

const runtime = vi.hoisted(() => ({
  snapshot: null as UpdateSnapshot | null,
  dismissUpdate: vi.fn(),
  setUpdateIdle: vi.fn(),
  claimUpdatePrompt: vi.fn(),
  checkForUpdates: vi.fn(),
  refreshInstalledUpdates: vi.fn(),
}));

vi.mock("../services/updates/runtime", () => ({
  useUpdateSnapshot: () => runtime.snapshot,
  dismissUpdate: runtime.dismissUpdate,
  setUpdateIdle: runtime.setUpdateIdle,
  claimUpdatePrompt: runtime.claimUpdatePrompt,
  checkForUpdates: runtime.checkForUpdates,
  refreshInstalledUpdates: runtime.refreshInstalledUpdates,
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

function renderPrompt() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<UpdatePrompt />} />
        <Route path="/settings/updates" element={<p>Updates screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  runtime.claimUpdatePrompt.mockImplementation(() => runtime.snapshot?.pending ?? null);
  runtime.refreshInstalledUpdates.mockImplementation(async () => runtime.snapshot);
  runtime.checkForUpdates.mockImplementation(async () => runtime.snapshot);
});

afterEach(() => {
  cleanup();
  runtime.snapshot = null;
  runtime.dismissUpdate.mockReset();
  runtime.setUpdateIdle.mockReset();
  runtime.claimUpdatePrompt.mockReset();
  runtime.checkForUpdates.mockReset();
  runtime.refreshInstalledUpdates.mockReset();
});

describe("update prompt", () => {
  it("renders nothing when no prompt is allowed", () => {
    runtime.snapshot = snapshot({ eligible: release() });
    renderPrompt();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it("shows the pending release and offers a non-forcing choice", () => {
    runtime.snapshot = snapshot({ pending: release(), popupEnabled: true });
    renderPrompt();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("0.15.0-beta.1 is ready")).toBeTruthy();
    expect(screen.getByText("Faster search and clearer failure messages.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "See what's new" })).toBeTruthy();
  });

  it("reports genuine idleness to the controller", () => {
    runtime.snapshot = snapshot();
    renderPrompt();
    expect(runtime.setUpdateIdle).toHaveBeenCalledWith(true);
  });

  it("dismisses the exact release when the reader says later", async () => {
    runtime.snapshot = snapshot({ pending: release(), popupEnabled: true });
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(runtime.dismissUpdate).toHaveBeenCalledWith("v0.15.0-beta.1");
  });

  it("treats Escape as dismissal, never as a silent close", async () => {
    runtime.snapshot = snapshot({ pending: release(), popupEnabled: true });
    renderPrompt();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(runtime.dismissUpdate).toHaveBeenCalledWith("v0.15.0-beta.1");
  });

  it("opens the permanent screen on 'See what's new', and dismisses so it is not re-asked", async () => {
    runtime.snapshot = snapshot({ pending: release(), popupEnabled: true });
    renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "See what's new" }));
    expect(runtime.dismissUpdate).toHaveBeenCalledWith("v0.15.0-beta.1");
    expect(await screen.findByText("Updates screen")).toBeTruthy();
  });
});
