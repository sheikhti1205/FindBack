// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, pendingMock, servicesMock } = vi.hoisted(() => ({
  authMock: {
    user: null as null | Record<string, unknown>,
    booting: false,
    pendingEmail: null as null | string,
    verifyPendingEmail: vi.fn(),
    resendPendingEmail: vi.fn(),
    refreshUser: vi.fn(),
  },
  pendingMock: { getPendingReportRoute: vi.fn((): string | null => null) },
  servicesMock: {
    sendPendingEmailCode: vi.fn(),
    verifyPendingEmailCode: vi.fn(),
  },
}));

vi.mock("../auth", () => ({ useAuth: () => authMock }));
vi.mock("../services/auth", () => servicesMock);
vi.mock("../utils/pendingReportLink", () => pendingMock);

import { Verify } from "./Verify";

function renderVerify(path = "/verify") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/verify" element={<Verify />} />
        <Route path="/signin" element={<p>Sign in destination</p>} />
        <Route path="/auth" element={<p>Auth gateway destination</p>} />
        <Route path="/posts/:id" element={<p>Shared report destination</p>} />
        <Route path="/" element={<p>Home destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authMock.user = null;
  authMock.pendingEmail = null;
  authMock.verifyPendingEmail.mockReset();
  authMock.resendPendingEmail.mockReset();
  authMock.refreshUser.mockReset();
  servicesMock.sendPendingEmailCode.mockReset();
  servicesMock.verifyPendingEmailCode.mockReset();
  pendingMock.getPendingReportRoute.mockReset();
  pendingMock.getPendingReportRoute.mockReturnValue(null);
});

afterEach(cleanup);

describe("Verify pending-signup mode (no session yet)", () => {
  const pending = { pendingEmail: "new@example.com" };

  beforeEach(() => {
    authMock.pendingEmail = pending.pendingEmail;
  });

  it("shows a clear heading, the destination email, and one accessible code input", () => {
    renderVerify();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByText("new@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("routes a successful verification to the pending report destination", async () => {
    pendingMock.getPendingReportRoute.mockReturnValue("/posts/abc123");
    authMock.verifyPendingEmail.mockResolvedValue({ id: "u1" });
    renderVerify();
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(authMock.verifyPendingEmail).toHaveBeenCalledWith("123456"));
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });

  it("announces resend status without leaving the screen", async () => {
    authMock.resendPendingEmail.mockResolvedValue(undefined);
    renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(authMock.resendPendingEmail).toHaveBeenCalled());
    expect(screen.getByRole("status")).toBeTruthy();
    // Still on verify: the code input is intact.
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("offers Back and a change-email exit that preserve backend behavior", () => {
    renderVerify();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    const change = screen.getByRole("link", { name: /different email/i });
    expect(change.getAttribute("href")).toBe("/auth");
  });

  it("keeps backend OTP errors verbatim and preserves the typed code", async () => {
    authMock.verifyPendingEmail.mockRejectedValue(new Error("Invalid or expired verification code"));
    renderVerify();
    const input = screen.getByLabelText("Verification code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() =>
      expect(screen.getByText("Invalid or expired verification code")).toBeTruthy(),
    );
    expect((screen.getByLabelText("Verification code") as HTMLInputElement).value).toBe("000000");
  });
});

describe("Verify signed-in mode", () => {
  beforeEach(() => {
    authMock.user = {
      id: "u1",
      username: "someone",
      email: "me@example.com",
      phone: "01812345678",
      emailVerified: false,
      phoneVerified: false,
    };
  });

  it("shows the destination email with resend status and a pending-aware continue", async () => {
    pendingMock.getPendingReportRoute.mockReturnValue("/posts/abc123");
    servicesMock.sendPendingEmailCode.mockResolvedValue(undefined);
    renderVerify();
    expect(screen.getByText("me@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await waitFor(() => expect(servicesMock.sendPendingEmailCode).toHaveBeenCalled());
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue to app" }));
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });
});
