// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getBuildInfo: vi.fn() }));
vi.mock("../services/buildInfo", () => ({ readBuildInfo: bridge.getBuildInfo }));

import { About } from "./About";
import { APP_VERSION, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "../services/appCapabilities";

afterEach(cleanup);

describe("About", () => {
  it("shows app version, build SHA, version code, and capability identity", async () => {
    bridge.getBuildInfo.mockResolvedValue({
      appVersion: "0.1.0",
      buildGitSha: "fdbd355abc123def456",
      versionCode: 1234,
    });
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(await screen.findByText(`FindBack ${APP_VERSION}`)).toBeTruthy();
    expect(screen.getByText("fdbd355abc12")).toBeTruthy();
    expect(screen.getByText("1234")).toBeTruthy();
    expect(screen.getByText(BACKEND_SCHEMA_VERSION)).toBeTruthy();
    expect(screen.getByText(CAPABILITIES_VERSION)).toBeTruthy();
  });

  it("degrades honestly when native identity is unavailable", async () => {
    bridge.getBuildInfo.mockRejectedValue(new Error("no bridge"));
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(await screen.findByText(`FindBack ${APP_VERSION}`)).toBeTruthy();
    expect(screen.getAllByText("unknown")).toHaveLength(2);
  });

  it("discloses the optional AI routes without offline claims", async () => {
    bridge.getBuildInfo.mockResolvedValue({ buildGitSha: "abc123", versionCode: 1 });
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(await screen.findByText(/provider key you add/)).toBeTruthy();
    expect(screen.getByText(/sent to your connected provider for suggestions/)).toBeTruthy();
    expect(screen.queryByText(/offline|on-device|GPU|download.*model/i)).toBeNull();
  });
});
