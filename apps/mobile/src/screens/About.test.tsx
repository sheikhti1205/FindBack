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

  it("states the current cloud-chat and on-device-helper semantics without retired mode claims", async () => {
    bridge.getBuildInfo.mockResolvedValue({ buildGitSha: "abc123", versionCode: 1 });
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(await screen.findByText(/provider key you add/)).toBeTruthy();
    expect(screen.getByText(/stay on the device/)).toBeTruthy();
    expect(screen.getByText(/core features work without AI/)).toBeTruthy();
    // The retired Automatic/On-device-only/Cloud-only switch is gone from the
    // consumer surface, so it must not be described as if it still existed.
    expect(screen.queryByText(/on-device-only/)).toBeNull();
    expect(screen.queryByText(/cloud-only/)).toBeNull();
    expect(screen.queryByText(/local-first/)).toBeNull();
    expect(screen.queryByText(/selected report photo is sent to your connected provider/)).toBeNull();
  });

  it("shows the consumer mission verbatim with one h1 and real links", async () => {
    bridge.getBuildInfo.mockResolvedValue({ buildGitSha: "abc123", versionCode: 1 });
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(
      await screen.findByText(
        "FindBack helps people report, discover and recover lost items without turning the experience into a public-data free-for-all.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/help");
    expect(hrefs).toContain("/notifications");
    expect(hrefs).toContain("/ai-connection");
  });

  it("names reactions (not likes) on the notifications row (FBX-035)", async () => {
    bridge.getBuildInfo.mockResolvedValue({ buildGitSha: "abc123", versionCode: 1 });
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(
      await screen.findByText("Reactions, comments, and mentions on your reports."),
    ).toBeTruthy();
    expect(screen.queryByText(/Likes, comments, and mentions/)).toBeNull();
  });

  it("keeps technical details inside the disclosure", async () => {
    bridge.getBuildInfo.mockResolvedValue({
      buildGitSha: "fdbd355abc123def456",
      versionCode: 1234,
    });
    render(<MemoryRouter><About /></MemoryRouter>);
    const disclosure = await screen.findByText("Technical details");
    const details = disclosure.closest("details") ?? document.body;
    expect(details.textContent).toContain("fdbd355abc12");
    expect(details.textContent).toContain("1234");
    expect(details.textContent).toContain(BACKEND_SCHEMA_VERSION);
    expect(details.textContent).toContain(CAPABILITIES_VERSION);
  });
});
