// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { servicesMock, recoveryMock } = vi.hoisted(() => ({
  recoveryMock: { verify: vi.fn(), updatePassword: vi.fn(), dispose: vi.fn() },
  servicesMock: {
    requestPasswordReset: vi.fn(),
    exchangeRecoveryCode: vi.fn(),
    updatePassword: vi.fn(),
    createPasswordRecovery: vi.fn(),
  },
}));
vi.mock("../services/auth", () => servicesMock);

import { ForgotPassword } from "./ForgotPassword";
import { Recovery } from "./Recovery";

function renderForgot(path = "/forgot") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/forgot" element={<ForgotPassword />} />
        <Route path="/recovery" element={<Recovery />} />
        <Route path="/signin" element={<p>Sign in destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRecovery(path: string | { pathname: string; state: Record<string, unknown>; search?: string } = "/recovery?code=pkce-code") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/recovery" element={<Recovery />} />
        <Route path="/forgot" element={<p>Forgot destination</p>} />
        <Route path="/signin" element={<p>Sign in destination</p>} />
        <Route path="/" element={<p>Home destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  servicesMock.requestPasswordReset.mockReset().mockResolvedValue(undefined);
  servicesMock.exchangeRecoveryCode.mockReset().mockResolvedValue(undefined);
  servicesMock.updatePassword.mockReset().mockResolvedValue(undefined);
  recoveryMock.verify.mockReset().mockResolvedValue(undefined);
  recoveryMock.updatePassword.mockReset().mockResolvedValue(undefined);
  recoveryMock.dispose.mockReset().mockResolvedValue(undefined);
  servicesMock.createPasswordRecovery.mockReset().mockReturnValue(recoveryMock);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ForgotPassword", () => {
  it("owns the viewport outside Shell (V1-UI-002: full-height main + safe-area insets)", () => {
    const { container } = renderForgot();
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main!.className).toMatch(/min-h-dvh/);
    expect(main!.style.paddingTop).toBe("max(2rem, env(safe-area-inset-top))");
    expect(main!.style.paddingBottom).toBe("max(2rem, env(safe-area-inset-bottom))");
  });

  it("prefills the email carried from sign-in", () => {
    renderForgot("/forgot?email=user%40example.com");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("user@example.com");
  });

  it("sends the reset request and always shows the same inbox message", async () => {
    renderForgot();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send recovery code" }));
    await screen.findByLabelText("Recovery code");
    expect(servicesMock.requestPasswordReset).toHaveBeenCalledWith("user@example.com");
    // No existence signal: the form is replaced by the message, nothing else.
    expect(screen.queryByRole("button", { name: "Send recovery code" })).toBeNull();
  });

  it("rejects invalid input without calling the service", () => {
    renderForgot();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send recovery code" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(servicesMock.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces service errors without inventing an inbox message", async () => {
    servicesMock.requestPasswordReset.mockRejectedValueOnce(new Error("Too many attempts. Please wait."));
    renderForgot();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send recovery code" }));
    await screen.findByText(/too many attempts/i);
  });
});

describe("Recovery", () => {
  const otpEntry = { pathname: "/recovery", state: { recoveryEmail: "recover@example.invalid" } };
  it("verifies a pasted recovery code, then changes the password without shared-session mutation", async () => {
    renderRecovery(otpEntry);
    const input = screen.getByLabelText("Recovery code") as HTMLInputElement;
    expect(input.maxLength).toBe(6); expect(input.autocomplete).toBe("one-time-code");
    fireEvent.paste(input, { clipboardData: { getData: () => "123 456" } });
    expect(input.value).toBe("123456");
    fireEvent.submit(input.closest("form")!);
    await screen.findByLabelText("New password");
    expect(recoveryMock.verify).toHaveBeenCalledWith("recover@example.invalid", "123456");
    expect(servicesMock.exchangeRecoveryCode).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-123" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByText(/can now sign in with your new password/i);
    expect(recoveryMock.updatePassword).toHaveBeenCalledWith("new-password-123");
    expect(servicesMock.updatePassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Sign in destination");
  });
  it("keeps expired recovery codes on the code screen without exposing a password form", async () => {
    recoveryMock.verify.mockRejectedValueOnce(new Error("Invalid or expired verification code"));
    renderRecovery(otpEntry);
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(recoveryMock.updatePassword).not.toHaveBeenCalled();
  });
  it("prevents duplicate code verification and discards abandoned results", async () => {
    let finish!: () => void;
    recoveryMock.verify.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = renderRecovery(otpEntry);
    const input = screen.getByLabelText("Recovery code");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form")!); fireEvent.submit(input.closest("form")!);
    expect(recoveryMock.verify).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { finish(); });
    expect(recoveryMock.dispose).toHaveBeenCalledTimes(1);
    expect(recoveryMock.updatePassword).not.toHaveBeenCalled();
  });
  it("gives a link callback priority over route-state OTP and never verifies both", async () => {
    renderRecovery({ ...otpEntry, search: "?code=link-fallback" });
    await screen.findByLabelText("New password");
    expect(servicesMock.exchangeRecoveryCode).toHaveBeenCalledTimes(1);
    expect(servicesMock.exchangeRecoveryCode).toHaveBeenCalledWith("link-fallback");
    expect(servicesMock.createPasswordRecovery).not.toHaveBeenCalled();
  });
  it("honors the initial resend cooldown, then requests a code without claiming delivery", async () => {
    vi.useFakeTimers(); renderRecovery(otpEntry);
    expect((screen.getByRole("button", { name: "Resend in 30s" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await screen.findByRole("button", { name: "Resend in 30s" });
    expect(servicesMock.requestPasswordReset).toHaveBeenCalledWith("recover@example.invalid");
    expect(screen.queryByText(/we sent/i)).toBeNull();
  });
  it("owns the viewport outside Shell (V1-UI-003: full-height main + safe-area insets)", () => {
    const { container } = renderRecovery();
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main!.className).toMatch(/min-h-dvh/);
    expect(main!.style.paddingTop).toBe("max(2rem, env(safe-area-inset-top))");
    expect(main!.style.paddingBottom).toBe("max(2rem, env(safe-area-inset-bottom))");
  });

  it("exchanges the link code, then accepts a matching new password", async () => {
    renderRecovery();
    await screen.findByLabelText("New password");
    expect(servicesMock.exchangeRecoveryCode).toHaveBeenCalledWith("pkce-code");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-123" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByText(/password is updated/i);
    expect(servicesMock.updatePassword).toHaveBeenCalledWith("new-password-123");
  });

  it("shows the invalid-link state without a code and never calls update", async () => {
    servicesMock.exchangeRecoveryCode.mockRejectedValueOnce(new Error("bad"));
    renderRecovery("/recovery");
    await screen.findByText(/invalid or expired/i);
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(servicesMock.updatePassword).not.toHaveBeenCalled();
  });

  it("refuses short and mismatched passwords locally", async () => {
    renderRecovery();
    await screen.findByLabelText("New password");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-123" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(servicesMock.updatePassword).not.toHaveBeenCalled();
  });
});
