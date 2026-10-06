// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    setUser: vi.fn(),
  },
  pendingMock: { getPendingReportRoute: vi.fn((): string | null => null) },
  servicesMock: {
    sendPendingEmailCode: vi.fn(),
    verifyPendingEmailCode: vi.fn(),
    sendPhoneChangeCode: vi.fn(),
    verifyPhoneChangeCode: vi.fn(),
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
  servicesMock.sendPhoneChangeCode.mockReset();
  servicesMock.verifyPhoneChangeCode.mockReset();
  authMock.setUser.mockReset();
  pendingMock.getPendingReportRoute.mockReset();
  pendingMock.getPendingReportRoute.mockReturnValue(null);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

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

    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    await waitFor(() => expect(servicesMock.sendPendingEmailCode).toHaveBeenCalled());
    expect(screen.getByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue to app" }));
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });

  it("sends to the displayed normalized phone, verifies and installs the refreshed public profile", async () => {
    const verified = { ...authMock.user, phoneVerified: true };
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    servicesMock.verifyPhoneChangeCode.mockResolvedValue(verified);
    renderVerify();
    expect(screen.getByText("+8801812345678")).toBeTruthy();
    expect(screen.queryByText(/isn't available yet/i)).toBeNull();
    const verify = screen.getByRole("button", { name: "Verify phone" }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    await waitFor(() => expect(servicesMock.sendPhoneChangeCode).toHaveBeenCalledWith("u1", "+8801812345678", false));
    expect((screen.getByRole("button", { name: "Resend in 60s" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "12345" } });
    expect(verify.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "123456" } });
    fireEvent.click(verify);
    await waitFor(() => expect(servicesMock.verifyPhoneChangeCode).toHaveBeenCalledWith("u1", "+8801812345678", "123456"));
    await waitFor(() => expect(authMock.setUser).toHaveBeenCalledWith(verified));
  });

  it("announces provider failure without pretending SMS was sent", async () => {
    servicesMock.sendPhoneChangeCode.mockRejectedValue(new Error("SMS verification is not enabled. Contact support."));
    renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    expect((await screen.findByRole("alert")).textContent).toContain("SMS verification is not enabled");
    expect(screen.queryByText(/Code sent to/)).toBeNull();
  });

  it("ignores a stale send after the displayed number changes", async () => {
    let resolve!: () => void;
    servicesMock.sendPhoneChangeCode.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const view = renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    authMock.user = { ...authMock.user, phone: "01912345678" };
    view.rerender(<MemoryRouter><Verify /></MemoryRouter>);
    await act(async () => resolve());
    expect(screen.queryByText(/Code sent to/)).toBeNull();
    expect(screen.getByText("+8801912345678")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Verify phone" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not apply a verification result after unmount", async () => {
    let resolve!: (u: Record<string, unknown>) => void;
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    servicesMock.verifyPhoneChangeCode.mockReturnValue(new Promise((r) => { resolve = r; }));
    const view = renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend in 60s" })).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    view.unmount();
    await act(async () => resolve({ ...authMock.user, phoneVerified: true }));
    expect(authMock.setUser).not.toHaveBeenCalled();
  });

  it("resends only after the 60-second cooldown and suppresses duplicate requests", async () => {
    vi.useFakeTimers();
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    renderVerify();
    const send = screen.getByRole("button", { name: "Send SMS code" });
    await act(async () => { fireEvent.click(send); fireEvent.click(send); });
    expect(servicesMock.sendPhoneChangeCode).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend SMS code" })); });
    expect(servicesMock.sendPhoneChangeCode).toHaveBeenLastCalledWith("u1", "+8801812345678", true);
    expect(servicesMock.sendPhoneChangeCode).toHaveBeenCalledTimes(2);
  });

  it("keeps invalid/expired codes visible for correction", async () => {
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    servicesMock.verifyPhoneChangeCode.mockRejectedValue(new Error("Invalid or expired verification code"));
    renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend in 60s" })).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid or expired");
    expect((screen.getByLabelText("Phone verification code") as HTMLInputElement).value).toBe("000000");
    expect(authMock.setUser).not.toHaveBeenCalled();
  });

  it("cools down verification retries when the provider rate-limits attempts", async () => {
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    servicesMock.verifyPhoneChangeCode.mockRejectedValue(new Error("Too many attempts. Please wait a moment and try again."));
    renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend in 60s" })).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
    expect((screen.getByRole("button", { name: "Verify again in 60s" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores an in-flight verification result after switching accounts", async () => {
    let resolve!: (u: Record<string, unknown>) => void;
    servicesMock.sendPhoneChangeCode.mockResolvedValue(undefined);
    servicesMock.verifyPhoneChangeCode.mockReturnValue(new Promise((r) => { resolve = r; }));
    const view = renderVerify();
    fireEvent.click(screen.getByRole("button", { name: "Send SMS code" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend in 60s" })).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Phone verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
    const previous = authMock.user!;
    authMock.user = { ...previous, id: "u2" };
    view.rerender(<MemoryRouter><Verify /></MemoryRouter>);
    await act(async () => resolve({ ...previous, phoneVerified: true }));
    expect(authMock.setUser).not.toHaveBeenCalled();
  });
});
