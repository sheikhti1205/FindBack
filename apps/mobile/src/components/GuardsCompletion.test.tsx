// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  booting: false,
  bootError: null as string | null,
  retryBoot: vi.fn(),
  needsProfile: null as {
    email: string;
    name: string | null;
    avatarUrl: string | null;
    phone: string;
    suggestedUsername: string;
  } | null,
  clearNeedsProfile: vi.fn(),
}));
vi.mock("../auth", () => ({
  useAuth: () => ({ ...auth }),
}));

import { GuestOnly } from "./Guards";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "../services/onboarding";

const origin = "https://findbackapp.social";
const postId = "5b6f7c8d-1234-4abc-8def-123456789012";

const SEED = {
  email: "google.user@example.com",
  name: "Google User",
  avatarUrl: null,
  phone: "",
  suggestedUsername: "google_user",
};

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

function renderGuard(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Location />
      <Routes>
        <Route path="/guarded" element={<GuestOnly><p>Auth form</p></GuestOnly>} />
        <Route path="/complete-profile" element={<p>Complete profile screen</p>} />
        <Route path="/auth" element={<p>Auth screen</p>} />
        <Route path="/onboarding" element={<p>Onboarding screen</p>} />
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/posts/:id" element={<p>Post screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function location() {
  return screen.getByTestId("location").textContent;
}

function seedPendingLink() {
  sessionStorage.setItem(
    "findback.pendingReportLink",
    JSON.stringify({ url: `${origin}/r/${postId}`, expiresAt: Date.now() + 60_000 }),
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
  auth.user = null;
  auth.booting = false;
  auth.bootError = null;
  auth.needsProfile = null;
  auth.clearNeedsProfile.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("GuestOnly restart-while-incomplete (W0-QA defect 1)", () => {
  it("routes a kept session with no profile (!user && needsProfile) to /complete-profile", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    auth.needsProfile = { ...SEED };
    renderGuard("/guarded");
    expect(screen.getByText("Complete profile screen")).toBeTruthy();
    expect(location()).toBe("/complete-profile");
  });

  it("completion wins over a pending shared-report launch (link kept for after)", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    auth.needsProfile = { ...SEED };
    seedPendingLink();
    renderGuard("/guarded");
    expect(location()).toBe("/complete-profile");
    // The link is NOT consumed by the guard — completion resumes it.
    expect(sessionStorage.getItem("findback.pendingReportLink")).toContain(postId);
  });

  it("completion wins over incomplete onboarding for a returning session", () => {
    auth.needsProfile = { ...SEED };
    renderGuard("/guarded");
    expect(location()).toBe("/complete-profile");
    expect(screen.queryByText("Onboarding screen")).toBeNull();
  });

  it("no redirect without needsProfile (existing guest behavior preserved)", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    renderGuard("/guarded");
    expect(screen.getByText("Auth form")).toBeTruthy();
    expect(location()).toBe("/guarded");
  });

  it("no redirect once the profile is complete (user set, needsProfile cleared)", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
    auth.user = { id: "u1" };
    auth.needsProfile = null;
    renderGuard("/guarded");
    expect(location()).toBe("/");
  });
});
