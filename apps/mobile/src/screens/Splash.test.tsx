// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "../services/onboarding";

const origin = "https://findbackapp.social";
const postId = "5b6f7c8d-1234-4abc-8def-123456789012";

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}{l.search}{l.hash}</output>;
}

function renderSplash() {
  return render(
    <MemoryRouter>
      <Location />
      <Splash />
    </MemoryRouter>,
  );
}

function location() {
  return screen.getByTestId("location").textContent;
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
  localStorage.clear();
  sessionStorage.clear();
});

const authState = vi.hoisted(() => ({
  user: null as null | { id: string },
  booting: true,
  bootError: null as string | null,
  retryBoot: vi.fn(),
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ ...authState }),
}));

import { Splash } from "./Splash";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Splash", () => {
  it("shows the brand mark while booting", () => {
    authState.user = null;
    authState.booting = true;
    authState.bootError = null;
    render(<MemoryRouter><Splash /></MemoryRouter>);
    expect(screen.getByText("FindBack")).toBeTruthy();
  });

  it("offers Retry without signing out when the backend is unreachable", () => {
    authState.user = null;
    authState.booting = false;
    authState.bootError = "unreachable";
    authState.retryBoot.mockClear();
    render(<MemoryRouter><Splash /></MemoryRouter>);
    expect(screen.getByText(/couldn't connect to findback/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(authState.retryBoot).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-in user to the pending report route, else home", () => {
    authState.user = { id: "u1" };
    authState.booting = false;
    authState.bootError = null;
    renderSplash();
    expect(location()).toBe("/");
    cleanup();
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    renderSplash();
    expect(location()).toBe(`/posts/${postId}`);
  });

  it("sends a fresh guest to /onboarding", () => {
    authState.user = null;
    authState.booting = false;
    authState.bootError = null;
    renderSplash();
    expect(location()).toBe("/onboarding");
  });

  it("sends a returning guest to /auth", () => {
    authState.user = null;
    authState.booting = false;
    authState.bootError = null;
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    renderSplash();
    expect(location()).toBe("/auth");
  });

  it("bypasses onboarding for a guest with a pending shared-report launch", () => {
    authState.user = null;
    authState.booting = false;
    authState.bootError = null;
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    renderSplash();
    expect(location()).toBe("/auth");
    expect(sessionStorage.getItem("findback.pendingReportLink")).toContain(postId);
  });
});
