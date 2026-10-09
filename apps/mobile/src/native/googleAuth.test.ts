import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W0-A (S1) — Google ID-token bridge contract.
 *
 * Pins the frozen INTERFACES.md S1 surface:
 *   - `isGoogleAuthAvailable()` fail-closed off Android,
 *   - `startGoogleSignIn({ mode })` maps signin → filterByAuthorizedAccounts=true
 *     (no phone request) and signup → false + requestVerifiedPhoneNumber=true,
 *   - the `GoogleAuthError` kind taxonomy,
 *   - the idToken is NEVER logged/printed (and never leaks into errors).
 *
 * Seam fakes only: the Capacitor module boundary is mocked (same convention as
 * `speechInput.test.ts`) and the native plugin is a fake object — no real
 * sign-in is ever performed here.
 */

const { fakeBridge, registerPluginMock, platform } = vi.hoisted(() => ({
  fakeBridge: {
    isAvailable: vi.fn<() => Promise<unknown>>(),
    signIn: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
  },
  registerPluginMock: vi.fn(),
  platform: { native: true, name: "android" },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: (name: string) => registerPluginMock(name),
}));

import {
  GoogleAuthError,
  isGoogleAuthAvailable,
  startGoogleSignIn,
} from "./googleAuth";

const TOKEN = "fake-id-token-for-tests-only";

function captureConsole(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    }),
  );
  return {
    calls,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** Fails if any console payload contains the raw token string. */
function expectNoTokenLeak(calls: unknown[][], token: string): void {
  for (const args of calls) {
    expect(JSON.stringify(args)).not.toContain(token);
  }
}

beforeEach(() => {
  fakeBridge.isAvailable.mockReset();
  fakeBridge.signIn.mockReset();
  registerPluginMock.mockReset().mockImplementation(() => fakeBridge);
  platform.native = true;
  platform.name = "android";
  // Configured by default: availability probe passes unless a test says otherwise.
  fakeBridge.isAvailable.mockResolvedValue({ available: true });
});

describe("isGoogleAuthAvailable", () => {
  it("is true on the Android app", () => {
    expect(isGoogleAuthAvailable()).toBe(true);
  });

  it("is false on web (fail closed, bridge never registered)", () => {
    platform.native = false;
    platform.name = "web";
    expect(isGoogleAuthAvailable()).toBe(false);
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("is false on non-Android native platforms", () => {
    platform.name = "ios";
    expect(isGoogleAuthAvailable()).toBe(false);
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("never registers the plugin on import or on the availability check path for web", () => {
    platform.native = false;
    platform.name = "web";
    isGoogleAuthAvailable();
    expect(registerPluginMock).not.toHaveBeenCalledWith("GoogleAuth");
  });
});

describe("startGoogleSignIn option mapping", () => {
  it("signin uses authorized-accounts-only with no phone request", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "n-signin" });
    await startGoogleSignIn({ mode: "signin" });
    expect(fakeBridge.signIn).toHaveBeenCalledTimes(1);
    const payload = fakeBridge.signIn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["filterByAuthorizedAccounts"]).toBe(true);
    expect("requestVerifiedPhoneNumber" in payload).toBe(false);
  });

  it("signup disables the authorized-accounts filter and requests verified phone", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "n-signup" });
    await startGoogleSignIn({ mode: "signup" });
    expect(fakeBridge.signIn).toHaveBeenCalledTimes(1);
    expect(fakeBridge.signIn.mock.calls[0]?.[0]).toEqual({
      filterByAuthorizedAccounts: false,
      requestVerifiedPhoneNumber: true,
    });
  });

  it("registers the GoogleAuth plugin lazily behind the Android guard", async () => {
    // The facade caches the bridge per module instance, so re-import a fresh
    // module to observe the registration itself (web-path tests above already
    // pin that registration never happens off Android).
    vi.resetModules();
    registerPluginMock.mockClear().mockImplementation(() => fakeBridge);
    const fresh = await import("./googleAuth");
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "n-lazy" });
    await fresh.startGoogleSignIn({ mode: "signin" });
    expect(registerPluginMock).toHaveBeenCalledWith("GoogleAuth");
  });
});

describe("startGoogleSignIn results", () => {
  it("passes through idToken and normalizes missing profile fields to null", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "raw-nonce-for-tests-only" });
    await expect(startGoogleSignIn({ mode: "signin" })).resolves.toEqual({
      idToken: TOKEN,
      nonce: "raw-nonce-for-tests-only",
      email: null,
      name: null,
      avatarUrl: null,
      phone: null,
    });
  });

  it("passes through email/name and a Google-hosted avatar", async () => {
    fakeBridge.signIn.mockResolvedValue({
      idToken: TOKEN,
      nonce: "n-avatar",
      email: "user@example.com",
      name: "Test User",
      avatarUrl: "https://lh3.googleusercontent.com/a/avatar",
    });
    const result = await startGoogleSignIn({ mode: "signup" });
    expect(result.email).toBe("user@example.com");
    expect(result.name).toBe("Test User");
    expect(result.avatarUrl).toBe("https://lh3.googleusercontent.com/a/avatar");
  });

  it("nulls a non-Google avatar URL (never an arbitrary remote URL)", async () => {
    fakeBridge.signIn.mockResolvedValue({
      idToken: TOKEN,
      nonce: "n-evil",
      avatarUrl: "https://evil.example.com/avatar.png",
    });
    const result = await startGoogleSignIn({ mode: "signin" });
    expect(result.avatarUrl).toBeNull();
  });

  it("nulls a non-https avatar URL", async () => {
    fakeBridge.signIn.mockResolvedValue({
      idToken: TOKEN,
      nonce: "n-http",
      avatarUrl: "http://lh3.googleusercontent.com/a/avatar",
    });
    const result = await startGoogleSignIn({ mode: "signin" });
    expect(result.avatarUrl).toBeNull();
  });

  it("passes through a legitimately returned phone on signup", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "n-phone", phone: "+8801XXXXXXXXX" });
    const result = await startGoogleSignIn({ mode: "signup" });
    expect(result.phone).toBe("+8801XXXXXXXXX");
  });

  it("rejects a missing idToken as unknown (never resolves empty success)", async () => {
    fakeBridge.signIn.mockResolvedValue({});
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unknown");
  });

  it("passes through the native raw nonce alongside the idToken", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "raw-nonce-abc123" });
    const result = await startGoogleSignIn({ mode: "signup" });
    expect(result.idToken).toBe(TOKEN);
    expect(result.nonce).toBe("raw-nonce-abc123");
  });

  it("rejects a missing nonce as unknown (never resolves without the Supabase raw nonce)", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN });
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unknown");
  });

  it("rejects an empty nonce as unknown", async () => {
    fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "" });
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unknown");
  });
});

describe("startGoogleSignIn fail-closed behavior", () => {
  it("rejects unavailable off-device without touching the bridge", async () => {
    platform.native = false;
    platform.name = "web";
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unavailable");
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("rejects misconfigured when the native availability probe reports unconfigured", async () => {
    fakeBridge.isAvailable.mockResolvedValue({ available: false, reason: "misconfigured" });
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("misconfigured");
    expect(fakeBridge.signIn).not.toHaveBeenCalled();
  });

  it("rejects unavailable when the native availability probe reports unavailable", async () => {
    fakeBridge.isAvailable.mockResolvedValue({ available: false, reason: "unavailable" });
    const err = await startGoogleSignIn({ mode: "signup" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unavailable");
    expect(fakeBridge.signIn).not.toHaveBeenCalled();
  });
});

describe("GoogleAuthError taxonomy", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["user_cancelled", "cancelled"],
    ["dismissed", "cancelled"],
    ["unavailable", "unavailable"],
    ["no_credential", "unavailable"],
    ["misconfigured", "misconfigured"],
    ["network", "network"],
    ["network_error", "network"],
    ["timeout", "network"],
    ["unknown", "unknown"],
  ])("maps native code %s to kind %s", async (code, kind) => {
    fakeBridge.signIn.mockRejectedValue({ code, message: "platform detail" });
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe(kind);
  });

  it("maps an unrecognized rejection to unknown", async () => {
    fakeBridge.signIn.mockRejectedValue({ code: "something_new", message: "???" });
    const err = await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).kind).toBe("unknown");
  });

  it("is an Error with the kind attached and a human message", async () => {
    fakeBridge.signIn.mockRejectedValue({ code: "cancelled" });
    const err = (await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e)) as GoogleAuthError;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GoogleAuthError");
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe("token privacy", () => {
  it("never logs the idToken on success", async () => {
    const consoleCapture = captureConsole();
    try {
      fakeBridge.signIn.mockResolvedValue({
        idToken: TOKEN,
        nonce: "n-privacy",
        email: "user@example.com",
      });
      await startGoogleSignIn({ mode: "signin" });
      expectNoTokenLeak(consoleCapture.calls, TOKEN);
    } finally {
      consoleCapture.restore();
    }
  });

  it("never leaks the idToken into rejection messages", async () => {
    const consoleCapture = captureConsole();
    try {
      // A hostile/misbehaving bridge echoes the token inside its error.
      fakeBridge.signIn.mockRejectedValue({ code: "unknown", message: `failed ${TOKEN}` });
      const err = (await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e)) as GoogleAuthError;
      expect(String(err.message)).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      expectNoTokenLeak(consoleCapture.calls, TOKEN);
    } finally {
      consoleCapture.restore();
    }
  });

  it("never logs the idToken on the signup-with-phone path", async () => {
    const consoleCapture = captureConsole();
    try {
      fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: "n-privacy-phone", phone: "+8801XXXXXXXXX" });
      await startGoogleSignIn({ mode: "signup" });
      expectNoTokenLeak(consoleCapture.calls, TOKEN);
    } finally {
      consoleCapture.restore();
    }
  });

  it("never logs the raw nonce on success", async () => {
    const consoleCapture = captureConsole();
    const rawNonce = "raw-nonce-must-never-be-logged";
    try {
      fakeBridge.signIn.mockResolvedValue({ idToken: TOKEN, nonce: rawNonce });
      await startGoogleSignIn({ mode: "signin" });
      expectNoTokenLeak(consoleCapture.calls, rawNonce);
    } finally {
      consoleCapture.restore();
    }
  });

  it("never leaks the raw nonce into rejection messages", async () => {
    const consoleCapture = captureConsole();
    const rawNonce = "raw-nonce-must-never-leak";
    try {
      // A hostile/misbehaving bridge echoes the nonce inside its error.
      fakeBridge.signIn.mockRejectedValue({ code: "unknown", message: `failed ${rawNonce}` });
      const err = (await startGoogleSignIn({ mode: "signin" }).catch((e: unknown) => e)) as GoogleAuthError;
      expect(String(err.message)).not.toContain(rawNonce);
      expect(JSON.stringify(err)).not.toContain(rawNonce);
      expectNoTokenLeak(consoleCapture.calls, rawNonce);
    } finally {
      consoleCapture.restore();
    }
  });
});
