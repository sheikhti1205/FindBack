// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getCapabilities: vi.fn() }));
vi.mock("../services/vlmPlugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/vlmPlugin")>();
  return { ...actual, getVlmBridge: () => bridge };
});

import { About } from "./About";
import { APP_VERSION, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "../services/appCapabilities";

afterEach(cleanup);

describe("About", () => {
  it("shows app version, build SHA, version code, and capability identity", async () => {
    bridge.getCapabilities.mockResolvedValue({
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
    bridge.getCapabilities.mockRejectedValue(new Error("no bridge"));
    render(<MemoryRouter><About /></MemoryRouter>);
    expect(await screen.findByText(`FindBack ${APP_VERSION}`)).toBeTruthy();
    expect(screen.getAllByText("unknown")).toHaveLength(2);
  });
});
