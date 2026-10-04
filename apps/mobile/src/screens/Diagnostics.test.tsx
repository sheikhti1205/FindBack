// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getBuildInfo: vi.fn() }));
vi.mock("../services/buildInfo", () => ({ readBuildInfo: bridge.getBuildInfo }));

const { permissionMock } = vi.hoisted(() => ({ permissionMock: vi.fn() }));
vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({
    permission: permissionMock,
    start: vi.fn(),
    openSettings: vi.fn(),
  }),
}));

import { Diagnostics } from "./Diagnostics";

beforeEach(() => {
  bridge.getBuildInfo.mockReset();
  permissionMock.mockReset();
  bridge.getBuildInfo.mockResolvedValue({
    buildGitSha: "fdbd355abc123def456",
    versionCode: 1234,
  });
  permissionMock.mockResolvedValue("granted");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Diagnostics", () => {
  it("renders one h1 backed to /settings with build, runtime state, and the monitoring check", async () => {
    const { container } = render(
      <MemoryRouter>
        <Diagnostics />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await screen.findByText("fdbd355abc12")).toBeTruthy();
    expect(screen.getByText("1234")).toBeTruthy();
    expect(screen.getByText(/device notifications: granted/i)).toBeTruthy();
    expect(
      screen.getByText(/monitoring self-test isn't enabled in this build/i) ||
        screen.getByRole("button", { name: /send monitoring test signal/i }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /ai & models/i }).getAttribute("href")).toBe(
      "/ai-models",
    );
    // Fixture data must never render secret-shaped strings.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/sb_secret_/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it("copies a sanitized bundle with no secret-shaped content", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <MemoryRouter>
        <Diagnostics />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /copy diagnostics/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const bundle = String(writeText.mock.calls.flat()[0] ?? "");
    expect(bundle).toContain("fdbd355abc123def456");
    expect(bundle).not.toMatch(/sb_secret_/);
    expect(bundle).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(await screen.findByText(/copied/i)).toBeTruthy();
  });
});
