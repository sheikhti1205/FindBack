// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  booting: false,
  bootError: null as string | null,
  retryBoot: vi.fn(),
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ ...auth }),
}));

import { GuestOnly, OnboardingRoute, RequireAuth } from "./Guards";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "../services/onboarding";

const origin = "https://findbackapp.social";
const postId = "5b6f7c8d-1234-4abc-8def-123456789012";

window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname}{l.search}{l.hash}</output>;
}

function renderGuard(entry: string, guard: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Location />
      <Routes>
        <Route path="/guarded" element={guard} />
        <Route path="/auth" element={<p>Auth screen</p>} />
        <Route path="/onboarding" element={<p>Onboarding screen</p>} />
        <Route path="/settings" element={<p>Settings screen</p>} />
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/posts/:id" element={<p>Post screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function location() {
  return screen.getByTestId("location").textContent;
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
  auth.user = null;
  auth.booting = false;
  auth.bootError = null;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("RequireAuth", () => {
  it("renders children for a signed-in user", () => {
    auth.user = { id: "u1" };
    renderGuard("/guarded", <RequireAuth><p>Secret</p></RequireAuth>);
    expect(screen.getByText("Secret")).toBeTruthy();
    expect(location()).toBe("/guarded");
  });

  it("sends an unauthenticated user to /auth (not /signin)", () => {
    renderGuard("/guarded", <RequireAuth><p>Secret</p></RequireAuth>);
    expect(screen.getByText("Auth screen")).toBeTruthy();
    expect(location()).toBe("/auth");
  });

  it("keeps the boot screen while booting or on boot error without a user", () => {
    auth.booting = true;
    renderGuard("/guarded", <RequireAuth><p>Secret</p></RequireAuth>);
    expect(screen.getByText("FindBack")).toBeTruthy();
    cleanup();
    auth.booting = false;
    auth.bootError = "unreachable";
    renderGuard("/guarded", <RequireAuth><p>Secret</p></RequireAuth>);
    expect(screen.getByText(/couldn't connect to findback/i)).toBeTruthy();
  });
});

describe("GuestOnly", () => {
  it("sends a signed-in user home (or to the pending report route)", () => {
    auth.user = { id: "u1" };
    renderGuard("/guarded", <GuestOnly><p>Auth form</p></GuestOnly>);
    expect(location()).toBe("/");
    cleanup();
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    renderGuard("/guarded", <GuestOnly><p>Auth form</p></GuestOnly>);
    expect(location()).toBe(`/posts/${postId}`);
  });

  it("sends a fresh guest with incomplete onboarding to /onboarding", () => {
    renderGuard("/guarded", <GuestOnly><p>Auth form</p></GuestOnly>);
    expect(screen.getByText("Onboarding screen")).toBeTruthy();
    expect(location()).toBe("/onboarding");
  });

  it("renders for a returning guest whose onboarding is complete", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    renderGuard("/guarded", <GuestOnly><p>Auth form</p></GuestOnly>);
    expect(screen.getByText("Auth form")).toBeTruthy();
    expect(location()).toBe("/guarded");
  });

  it("does not steal a pending shared-report launch (guest stays, link intact)", () => {
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    renderGuard("/guarded", <GuestOnly><p>Auth form</p></GuestOnly>);
    expect(screen.getByText("Auth form")).toBeTruthy();
    expect(sessionStorage.getItem("findback.pendingReportLink")).toContain(postId);
  });
});

describe("OnboardingRoute", () => {
  it("renders onboarding for a fresh guest and finishes to /auth", () => {
    renderGuard("/guarded", <OnboardingRoute />);
    expect(screen.getByRole("heading", { level: 1, name: /lose less\. find faster\./i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(String(ONBOARDING_VERSION));
  });

  it("sends a returning guest to /auth", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    renderGuard("/guarded", <OnboardingRoute />);
    expect(screen.getByText("Auth screen")).toBeTruthy();
    expect(location()).toBe("/auth");
  });

  it("bypasses a pending shared-report launch to /auth without consuming the link", () => {
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
    );
    renderGuard("/guarded", <OnboardingRoute />);
    expect(screen.getByText("Auth screen")).toBeTruthy();
    expect(location()).toBe("/auth");
    expect(sessionStorage.getItem("findback.pendingReportLink")).toContain(postId);
  });

  it("sends a signed-in user home (pending link wins)", () => {
    auth.user = { id: "u1" };
    renderGuard("/guarded", <OnboardingRoute />);
    expect(location()).toBe("/");
  });

  it("replays for a signed-in user and returns to /settings with completion intact", () => {
    auth.user = { id: "u1" };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    renderGuard("/guarded?replay=1", <OnboardingRoute />);
    expect(screen.getByRole("heading", { level: 1, name: /lose less\. find faster\./i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(String(ONBOARDING_VERSION));
    expect(screen.getByText("Settings screen")).toBeTruthy();
    expect(location()).toBe("/settings");
  });
});
