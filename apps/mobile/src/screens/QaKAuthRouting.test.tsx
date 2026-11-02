// @vitest-environment jsdom
// QA-K audit matrix: post-auth resume paths that had no direct test —
// signup-success routing (pending → /verify, authenticated → pending link),
// guest replay (?replay=1 with no session), and the empty-/verify redirect.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, pendingMock, servicesMock } = vi.hoisted(() => ({
  authMock: {
    user: null as null | { id: string },
    booting: false,
    pendingEmail: null as null | string,
    login: vi.fn(),
    register: vi.fn(),
    verifyPendingEmail: vi.fn(),
    resendPendingEmail: vi.fn(),
    refreshUser: vi.fn(),
  },
  pendingMock: { getPendingReportRoute: vi.fn((): string | null => null) },
  servicesMock: {
    checkUsername: vi.fn(),
    sendPendingEmailCode: vi.fn(),
    verifyPendingEmailCode: vi.fn(),
  },
}));

vi.mock("../auth", () => ({ useAuth: () => authMock }));
vi.mock("../services/auth", () => servicesMock);
vi.mock("../utils/pendingReportLink", () => pendingMock);

import { checkUsername } from "../services/auth";
import { Register } from "./Register";
import { SignIn } from "./SignIn";
import { ApiError } from "../services/session";
import { AuthGateway } from "./AuthGateway";
import { __setGoogleSignInSeams, __resetGoogleSignInSeams } from "../components/auth/GoogleSignInButton";
import { Verify } from "./Verify";
import { OnboardingRoute } from "../components/Guards";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from "../services/onboarding";

const mockCheckUsername = vi.mocked(checkUsername);

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

async function fillValidSignup() {
  mockCheckUsername.mockResolvedValue({ available: true, normalized: "qakane" });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "qakane" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "qa-k@example.com" } });
  fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
    target: { value: "01812345678" },
  });
  fireEvent.change(screen.getByTestId("password-field"), { target: { value: "correct-horse-1" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "correct-horse-1" },
  });
  // Live username check is debounced (350ms); the submit gate requires it
  // to have answered "available" before the account goes through.
  await new Promise((r) => setTimeout(r, 400));
  await waitFor(() => expect(screen.getByText("✓ Username available")).toBeTruthy());
}

function renderRoutes(entry: string, routes: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[entry]}><Routes>{routes}</Routes></MemoryRouter>);
}

beforeEach(() => {
  authMock.user = null;
  authMock.booting = false;
  authMock.pendingEmail = null;
  authMock.register.mockReset();
  mockCheckUsername.mockReset();
  pendingMock.getPendingReportRoute.mockReset();
  pendingMock.getPendingReportRoute.mockReturnValue(null);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => { cleanup(); __resetGoogleSignInSeams(); });

describe("QA-K signup-success routing (post-auth resume matrix)", () => {
  it.each(["email", "signin", "signup"] as const)("exposes Google on the %s auth entry when available", (mode) => {
    __setGoogleSignInSeams({ strategy: () => "web-oauth" });
    renderRoutes("/auth", <Route path="/auth" element={<AuthGateway initialMode={mode} />} />);
    expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy();
  });
  it("resumes verification on password-verified email_not_confirmed", async () => {
    authMock.login.mockRejectedValueOnce(new ApiError("Verify email", 403, "email_not_confirmed"));
    renderRoutes("/signin", <>
      <Route path="/signin" element={<SignIn email="pending@example.invalid" />} />
      <Route path="/verify" element={<p>Verify destination</p>} />
    </>);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Verify destination");
  });
  it("routes a pending signup to /verify (pending-email state entry)", async () => {
    authMock.register.mockResolvedValue({ status: "pending", email: "qa-k@example.com" });
    renderRoutes("/register", <>
      <Route path="/register" element={<Register />} />
      <Route path="/verify" element={<p>Verify destination</p>} />
      <Route path="/" element={<p>Home destination</p>} />
    </>);
    await fillValidSignup();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(authMock.register).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Verify destination")).toBeTruthy());
  });

  it("routes an already-authenticated signup to the pending report link", async () => {
    pendingMock.getPendingReportRoute.mockReturnValue("/posts/5b6f7c8d-1234-4abc-8def-123456789012");
    authMock.register.mockResolvedValue({ status: "authenticated", user: { id: "u1" } });
    renderRoutes("/register", <>
      <Route path="/register" element={<Register />} />
      <Route path="/posts/:id" element={<p>Shared report destination</p>} />
      <Route path="/" element={<p>Home destination</p>} />
    </>);
    await fillValidSignup();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(authMock.register).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });

  it("surfaces a duplicate signup with the safe generic wording (no field oracle)", async () => {
    authMock.register.mockRejectedValue(
      new Error("An account with these details already exists."),
    );
    renderRoutes("/register", <>
      <Route path="/register" element={<Register />} />
    </>);
    await fillValidSignup();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(
        screen.getByText("An account with these details already exists."),
      ).toBeTruthy(),
    );
    // The message names no field, so it cannot oracle email vs username.
    expect(screen.getByRole("alert").textContent).not.toMatch(/email|username/i);
  });
});

describe("QA-K guard matrix additions", () => {
  it("renders replay onboarding for a guest and finishes to /auth", () => {
    renderRoutes("/onboarding?replay=1", <>
      <Route path="/onboarding" element={<OnboardingRoute />} />
      <Route path="/auth" element={<p>Auth screen</p>} />
      <Route path="/settings" element={<p>Settings screen</p>} />
    </>);
    expect(
      screen.getByRole("heading", { level: 1, name: "Lost something?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(String(ONBOARDING_VERSION));
    expect(screen.getByText("Auth screen")).toBeTruthy();
  });

  it("sends an empty /verify visit (no session, no pending email) to /signin", () => {
    renderRoutes("/verify", <>
      <Route path="/verify" element={<Verify />} />
      <Route path="/signin" element={<p>Sign in destination</p>} />
      <Route path="/auth" element={<p>Auth gateway destination</p>} />
    </>);
    expect(screen.getByText("Sign in destination")).toBeTruthy();
  });
});
