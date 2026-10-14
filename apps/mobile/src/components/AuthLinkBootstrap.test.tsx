// @vitest-environment jsdom
/**
 * X3/X4/X17 — the external auth entry bridge inside the HashRouter.
 *
 * The bridge consumes a stashed callback entry (browser OAuth / recovery),
 * exchanges it exactly once, and routes to the right destination without ever
 * navigating to an attacker-controlled URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const hoisted = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  completeGoogleWebCallback: vi.fn(),
  exchangeRecoveryCode: vi.fn(),
  adopt: vi.fn(),
  getPendingReportRoute: vi.fn((): string | null => null),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => hoisted.isNativePlatform() } }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), getLaunchUrl: vi.fn(async () => undefined) },
}));
vi.mock("../auth", () => ({ useAuth: () => ({ adoptExternalAuthOutcome: hoisted.adopt }) }));
vi.mock("../services/auth", () => ({ exchangeRecoveryCode: (...a: unknown[]) => hoisted.exchangeRecoveryCode(...a) }));
vi.mock("../services/auth/googleSignIn", () => ({
  completeGoogleWebCallback: (...a: unknown[]) => hoisted.completeGoogleWebCallback(...a),
}));
vi.mock("../utils/pendingReportLink", () => ({
  getPendingReportRoute: () => hoisted.getPendingReportRoute(),
}));

import { AuthLinkBootstrap } from "./AuthLinkBootstrap";
import { __setPendingExternalAuthEntry } from "../utils/externalAuthEntry";
import { rememberAuthReturnTo } from "../utils/authReturnTo";

function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="probe">
      {location.pathname}|{JSON.stringify(location.state)}
    </p>
  );
}

function renderWith(entry: Parameters<typeof __setPendingExternalAuthEntry>[0]) {
  __setPendingExternalAuthEntry(entry);
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthLinkBootstrap />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hoisted.isNativePlatform.mockReturnValue(false);
  for (const fn of [hoisted.completeGoogleWebCallback, hoisted.exchangeRecoveryCode, hoisted.adopt]) fn.mockReset();
  hoisted.getPendingReportRoute.mockReturnValue(null);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthLinkBootstrap", () => {
  it("exchanges a web Google callback, adopts the outcome, and lands home", async () => {
    hoisted.completeGoogleWebCallback.mockResolvedValue({
      status: "authenticated",
      user: { id: "u1", username: "u", email: "e", phone: "", emailVerified: true, phoneVerified: false, avatarUrl: null, createdAt: "" },
    });
    renderWith({ kind: "auth-callback", code: "code-1", error: "", path: "/auth/callback?code=code-1" });

    await waitFor(() => expect(hoisted.completeGoogleWebCallback).toHaveBeenCalledWith("code-1"));
    await waitFor(() => expect(hoisted.adopt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('[data-testid="probe"]')?.textContent?.startsWith("/|")).toBe(true));
  });

  it("returns to the remembered internal route after the callback", async () => {
    rememberAuthReturnTo("/posts/abc");
    hoisted.completeGoogleWebCallback.mockResolvedValue({
      status: "authenticated",
      user: { id: "u1", username: "u", email: "e", phone: "", emailVerified: true, phoneVerified: false, avatarUrl: null, createdAt: "" },
    });
    renderWith({ kind: "auth-callback", code: "code-2", error: "", path: "/auth/callback?code=code-2" });

    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent?.startsWith("/posts/abc|")).toBe(true),
    );
  });

  it("routes a needsProfile outcome to /complete-profile carrying the seed", async () => {
    const seed = { accountId: "user-new", email: "n@example.com", name: "N", avatarUrl: null, phone: "", suggestedUsername: "n" };
    hoisted.completeGoogleWebCallback.mockResolvedValue({ status: "needsProfile", seed });
    renderWith({ kind: "auth-callback", code: "code-3", error: "", path: "/auth/callback?code=code-3" });

    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("/complete-profile"),
    );
    expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain(seed.email);
  });

  it("surfaces a provider error on /auth without navigating externally", async () => {
    renderWith({ kind: "auth-callback", code: "", error: "access_denied", path: "/auth/callback?error=access_denied" });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("/auth"),
    );
    expect(hoisted.completeGoogleWebCallback).not.toHaveBeenCalled();
  });

  it("exchanges a recovery code and lands on /recovery as recovered", async () => {
    hoisted.exchangeRecoveryCode.mockResolvedValue(undefined);
    renderWith({ kind: "recovery", code: "rec-code", error: "", path: "/recovery?code=rec-code" });

    await waitFor(() => expect(hoisted.exchangeRecoveryCode).toHaveBeenCalledWith("rec-code"));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("/recovery"),
    );
    expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("recovered");
  });

  it("marks an invalid (missing-code) recovery link", async () => {
    renderWith({ kind: "recovery", code: "", error: "", path: "/recovery" });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("linkError"),
    );
    expect(hoisted.exchangeRecoveryCode).not.toHaveBeenCalled();
  });

  it("shows the recovery invalid-link screen (never the Google error) when the exchange fails", async () => {
    hoisted.exchangeRecoveryCode.mockRejectedValue(new Error("expired or already used"));
    renderWith({ kind: "recovery", code: "used-code", error: "", path: "/recovery?code=used-code" });
    await waitFor(() => expect(hoisted.exchangeRecoveryCode).toHaveBeenCalledWith("used-code"));
    const probe = () => document.querySelector('[data-testid="probe"]')?.textContent ?? "";
    await waitFor(() => expect(probe()).toContain("/recovery"));
    expect(probe()).toContain("linkError");
    // Must NOT be misrouted to the Google error path.
    expect(probe()).not.toContain("/auth");
    expect(probe()).not.toContain("googleError");
    expect(document.body.textContent).not.toContain("used-code");
  });

  it("routes home when the provider exchange fails (never leaks the code)", async () => {
    hoisted.completeGoogleWebCallback.mockRejectedValue(new Error("boom code-leak-guard"));
    renderWith({ kind: "auth-callback", code: "code-fail", error: "", path: "/auth/callback?code=code-fail" });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="probe"]')?.textContent).toContain("/auth"),
    );
    expect(document.body.textContent).not.toContain("code-fail");
  });
});
