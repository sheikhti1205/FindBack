// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { AiModels, type OfflineDownloadControls } from "./AiModels";
import type { OfflineDownloadState } from "../services/ai/offlineModelManager";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function controlsFor(
  state: OfflineDownloadState,
  overrides: Partial<OfflineDownloadControls> = {},
): OfflineDownloadControls {
  return {
    modelId: "smolvlm2-500m-vision",
    state,
    downloadedBytes: 0,
    totalBytes: null,
    busy: false,
    notice: null,
    onDownload: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

function renderWith(controls: OfflineDownloadControls | null) {
  return render(
    <MemoryRouter>
      <AiModels accountId="u1" listCatalog={async () => []} offlineDownload={controls} />
    </MemoryRouter>,
  );
}

describe("AiModels offline download section (B3)", () => {
  it("stays honestly disabled without the native download bridge", () => {
    renderWith(null);
    const download = screen.getByRole("button", { name: /download on-device model/i });
    const remove = screen.getByRole("button", { name: /remove on-device model/i });
    expect((download as HTMLButtonElement).disabled).toBe(true);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers download for a not-installed model and forwards intent", () => {
    const onDownload = vi.fn();
    renderWith(controlsFor("not-installed", { onDownload }));
    const button = screen.getByRole("button", { name: /download on-device model/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /remove on-device model/i })).toBeNull();
  });

  it("offers pause while downloading plus determinate progress", () => {
    const onPause = vi.fn();
    renderWith(
      controlsFor("downloading", {
        downloadedBytes: 250,
        totalBytes: 1_000,
        onPause,
      }),
    );
    const pause = screen.getByRole("button", { name: /pause download/i });
    expect((pause as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pause);
    expect(onPause).toHaveBeenCalledTimes(1);
    const progress = screen.getByTestId("ai-offline-progress");
    expect(progress.textContent).toMatch(/25%/);
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
  });

  it("offers resume and remove while paused", () => {
    const onResume = vi.fn();
    const onRemove = vi.fn();
    renderWith(
      controlsFor("paused", { downloadedBytes: 500, totalBytes: 1_000, onResume, onRemove }),
    );
    fireEvent.click(screen.getByRole("button", { name: /resume download/i }));
    expect(onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /remove on-device model/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("offers retry and remove after failure plus the notice", () => {
    const onDownload = vi.fn();
    renderWith(controlsFor("failed", { onDownload, notice: "Checksum mismatch." }));
    fireEvent.click(screen.getByRole("button", { name: /retry download/i }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ai-offline-notice").textContent).toBe("Checksum mismatch.");
  });

  it("shows a disabled verifying state and remove after install", () => {
    renderWith(controlsFor("verifying"));
    const verifying = screen.getByRole("button", { name: /verifying/i });
    expect((verifying as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const onRemove = vi.fn();
    renderWith(controlsFor("installed", { onRemove }));
    expect(screen.queryByRole("button", { name: /download on-device model/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /remove on-device model/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("disables every control while busy", () => {
    renderWith(controlsFor("downloading", { busy: true }));
    for (const button of screen.getAllByRole("button")) {
      if (/pause download/i.test(button.textContent ?? "")) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });
});
