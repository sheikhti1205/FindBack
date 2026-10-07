// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { servicesMock } = vi.hoisted(() => ({
  servicesMock: {
    requestPasswordReset: vi.fn(),
    exchangeRecoveryCode: vi.fn(),
    updatePassword: vi.fn(),
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
        <Route path="/signin" element={<p>Sign in destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderRecovery(path = "/recovery?code=pkce-code") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/recovery" element={<Recovery />} />
        <Route path="/forgot" element={<p>Forgot destination</p>} />
        <Route path="/" element={<p>Home destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  servicesMock.requestPasswordReset.mockReset().mockResolvedValue(undefined);
  servicesMock.exchangeRecoveryCode.mockReset().mockResolvedValue(undefined);
  servicesMock.updatePassword.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

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
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText(/a reset link is on its way/i);
    expect(servicesMock.requestPasswordReset).toHaveBeenCalledWith("user@example.com");
    // No existence signal: the form is replaced by the message, nothing else.
    expect(screen.queryByRole("button", { name: "Send reset link" })).toBeNull();
  });

  it("rejects invalid input without calling the service", () => {
    renderForgot();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(servicesMock.requestPasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces service errors without inventing an inbox message", async () => {
    servicesMock.requestPasswordReset.mockRejectedValueOnce(new Error("Too many attempts. Please wait."));
    renderForgot();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText(/too many attempts/i);
  });
});

describe("Recovery", () => {
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
