// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-seam pin for the Google sign-in failure path.
 *
 * The two neighbouring suites each faked the other side of the seam and both
 * stayed green while the real thing was broken:
 *   - `src/native/googleAuth.test.ts` fakes rejections as `{ code, message }`,
 *     the shape the taxonomy *wants*;
 *   - `GoogleSignInButton.test.tsx` fakes errors that already carry `kind`.
 *
 * On device the native plugin actually sent
 * `{ message, code: null, data: { code } }`, so every native failure collapsed
 * onto `unknown`: the user got "Google sign-in failed. Please try again." for
 * causes that already had actionable copy, and got an error banner for a plain
 * cancellation. Only a test that crosses the seam (REAL bridge facade + REAL
 * button) can catch that, so this file exists.
 */

const { fakeBridge, registerPluginMock } = vi.hoisted(() => ({
  fakeBridge: {
    isAvailable: vi.fn<() => Promise<unknown>>(),
    signIn: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
  },
  registerPluginMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
  registerPlugin: () => registerPluginMock(),
}));

import { startGoogleSignIn } from "../../native/googleAuth";
import {
  GoogleSignInButton,
  __resetGoogleSignInSeams,
  __setGoogleSignInSeams,
} from "./GoogleSignInButton";

/** Exactly what Capacitor delivers for `reject(message, JSObject)`. */
const PLATFORM_DETAIL = "platform detail that must never reach the user";
const packedRejection = (code: string) => ({
  message: PLATFORM_DETAIL,
  code: null,
  data: { code, message: PLATFORM_DETAIL },
});

beforeEach(() => {
  registerPluginMock.mockReset().mockImplementation(() => fakeBridge);
  fakeBridge.isAvailable.mockReset().mockResolvedValue({ available: true });
  fakeBridge.signIn.mockReset();
  __setGoogleSignInSeams({
    strategy: () => "android-native",
    // The REAL facade — this is the whole point of the file.
    startGoogleSignIn,
    signInWithGoogleIdToken: async () => {
      throw new Error("the Supabase exchange must not run when Google failed");
    },
  });
});

afterEach(() => {
  cleanup();
  __resetGoogleSignInSeams();
  vi.restoreAllMocks();
});

function press() {
  render(<GoogleSignInButton mode="signup" onDone={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
}

/** The button element, for re-use assertions (no jest-dom dependency). */
function button(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Continue with Google" }) as HTMLButtonElement;
}

describe("Google sign-in failure copy, real bridge → real button", () => {
  it("tells the user to add a Google account when the device has none", async () => {
    fakeBridge.signIn.mockRejectedValue(packedRejection("unavailable"));
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no Google account found/i);
    expect(alert.textContent).toMatch(/Add a Google account and try again/i);
    // The unactionable generic copy is what shipped; it must not be the answer.
    expect(alert.textContent).not.toMatch(/failed\. Please try again/i);
    expect(alert.textContent).not.toContain(PLATFORM_DETAIL);
  });

  it("stays silent when the user dismisses the Google sheet", async () => {
    fakeBridge.signIn.mockRejectedValue(packedRejection("cancelled"));
    press();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("points at another method when Google sign-in is not configured", async () => {
    fakeBridge.signIn.mockRejectedValue(packedRejection("misconfigured"));
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/another sign-in method/i);
  });

  it("reports a connection problem for a network failure", async () => {
    fakeBridge.signIn.mockRejectedValue(packedRejection("network"));
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/check your connection/i);
  });

  it("reads a top-level code too (the fixed native packing)", async () => {
    fakeBridge.signIn.mockRejectedValue({ message: PLATFORM_DETAIL, code: "unavailable" });
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no Google account found/i);
  });

  it("falls back to the generic copy for an unknown kind", async () => {
    fakeBridge.signIn.mockRejectedValue(packedRejection("something_new"));
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/failed\. Please try again/i);
  });
});
