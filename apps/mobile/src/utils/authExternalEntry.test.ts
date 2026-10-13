// @vitest-environment jsdom
/**
 * X3/X4/X17 — external auth entry bridge for the HashRouter app.
 *
 * Pure parsing + origin allowlist + one-shot return-to storage + capture/strip.
 * No network, no Supabase: these are the safety properties an OAuth/recovery
 * link must satisfy before any credential is exchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CALLBACK_PATH,
  RECOVERY_PATH,
  authCallbackUrl,
  isAllowedAuthOrigin,
  isLocalDevOrigin,
  allowedAuthOrigins,
  recoveryUrl,
} from "./authRedirect";
import {
  consumeAuthReturnTo,
  isSafeInternalRoute,
  rememberAuthReturnTo,
  clearAuthReturnTo,
} from "./authReturnTo";
import {
  captureExternalAuthEntryFromWindow,
  parseExternalAuthEntry,
  takePendingExternalAuthEntry,
  __setPendingExternalAuthEntry,
} from "./externalAuthEntry";

beforeEach(() => {
  sessionStorage.clear();
  __setPendingExternalAuthEntry(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("authRedirect origin allowlist", () => {
  it("allows the production, Azure, and loopback dev origins", () => {
    expect(isAllowedAuthOrigin("https://findbackapp.social")).toBe(true);
    expect(isAllowedAuthOrigin("https://ambitious-wave-0f1b6c500.3.azurestaticapps.net")).toBe(true);
    expect(isAllowedAuthOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedAuthOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("rejects attacker and near-miss origins", () => {
    expect(isAllowedAuthOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://findbackapp.social.evil.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://findbackapp.social:8443")).toBe(false);
    expect(isAllowedAuthOrigin("")).toBe(false);
  });

  it("derives the share origin from env (single source) and normalizes trailing slashes", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://share.example.com/");
    expect(allowedAuthOrigins()).toContain("https://share.example.com");
    expect(isAllowedAuthOrigin("https://findbackapp.social/")).toBe(true);
  });

  it("builds absolute callback and recovery URLs", () => {
    expect(authCallbackUrl("https://findbackapp.social/")).toBe(
      `https://findbackapp.social${AUTH_CALLBACK_PATH}`,
    );
    expect(recoveryUrl("https://findbackapp.social")).toBe(
      `https://findbackapp.social${RECOVERY_PATH}`,
    );
  });

  it("treats only loopback hosts as local dev", () => {
    expect(isLocalDevOrigin("http://localhost:9")).toBe(true);
    expect(isLocalDevOrigin("https://127.0.0.1")).toBe(true);
    expect(isLocalDevOrigin("https://findbackapp.social")).toBe(false);
    expect(isLocalDevOrigin("not a url")).toBe(false);
  });
});

describe("parseExternalAuthEntry", () => {
  it("recognises the OAuth callback and the recovery landing", () => {
    expect(parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, search: "" })?.kind).toBe("auth-callback");
    expect(parseExternalAuthEntry({ pathname: RECOVERY_PATH, search: "" })?.kind).toBe("recovery");
  });

  it("ignores every other path", () => {
    expect(parseExternalAuthEntry({ pathname: "/", search: "" })).toBeNull();
    expect(parseExternalAuthEntry({ pathname: "/auth", search: "" })).toBeNull();
    expect(parseExternalAuthEntry({ pathname: "/recovery/extra", search: "" })).toBeNull();
  });

  it("extracts the PKCE code and provider error", () => {
    const entry = parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, search: "?code=abc-123" });
    expect(entry?.code).toBe("abc-123");
    const errored = parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, search: "?error=access_denied" });
    expect(errored?.error).toBe("access_denied");
  });

  it("rejects a credential carrying control characters or absurd length", () => {
    expect(parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, search: "?code=a%00b" })?.code).toBe("");
    expect(
      parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, search: `?code=${"x".repeat(5000)}` })?.code,
    ).toBe("");
  });

  it("rejects a disallowed origin but accepts an allowlisted one", () => {
    expect(
      parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, origin: "https://evil.example.com" }),
    ).toBeNull();
    expect(
      parseExternalAuthEntry({ pathname: AUTH_CALLBACK_PATH, origin: "https://findbackapp.social" }),
    ).not.toBeNull();
  });

  it("keeps working when no origin is supplied (path-only parse)", () => {
    expect(parseExternalAuthEntry({ pathname: RECOVERY_PATH })?.kind).toBe("recovery");
  });
});

describe("captureExternalAuthEntryFromWindow — strip and stash", () => {
  it("strips a credential-bearing auth path from the address bar via replaceState", () => {
    const replaceState = vi.fn();
    const win = {
      location: {
        pathname: AUTH_CALLBACK_PATH,
        search: "?code=secret-code",
        origin: "https://findbackapp.social",
      },
      history: { replaceState },
    } as unknown as Window;

    const entry = captureExternalAuthEntryFromWindow(win);

    expect(entry?.kind).toBe("auth-callback");
    expect(entry?.code).toBe("secret-code");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(takePendingExternalAuthEntry()?.code).toBe("secret-code");
    // One-shot: a second take is empty.
    expect(takePendingExternalAuthEntry()).toBeNull();
  });

  it("does nothing on a non-auth path", () => {
    const replaceState = vi.fn();
    const win = {
      location: { pathname: "/", search: "", origin: "https://findbackapp.social" },
      history: { replaceState },
    } as unknown as Window;
    expect(captureExternalAuthEntryFromWindow(win)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("authReturnTo — safe internal route only", () => {
  it("accepts single-slash internal routes", () => {
    expect(isSafeInternalRoute("/posts/abc")).toBe(true);
    expect(isSafeInternalRoute("/")).toBe(true);
  });

  it("rejects protocol-relative, absolute, backslash, and control routes", () => {
    expect(isSafeInternalRoute("//evil.example.com")).toBe(false);
    expect(isSafeInternalRoute("https://evil.example.com")).toBe(false);
    expect(isSafeInternalRoute("/\\evil")).toBe(false);
    expect(isSafeInternalRoute("/a b")).toBe(false);
    expect(isSafeInternalRoute("")).toBe(false);
    expect(isSafeInternalRoute(42)).toBe(false);
  });

  it("round-trips a safe route once and clears it", () => {
    rememberAuthReturnTo("/posts/xyz");
    expect(consumeAuthReturnTo()).toBe("/posts/xyz");
    expect(consumeAuthReturnTo()).toBeNull();
  });

  it("never stores an unsafe route", () => {
    rememberAuthReturnTo("//evil.example.com");
    expect(consumeAuthReturnTo()).toBeNull();
  });

  it("treats an expired entry as consumed-and-gone", () => {
    sessionStorage.setItem(
      "findback.authReturnTo",
      JSON.stringify({ route: "/posts/old", expiresAt: Date.now() - 1000 }),
    );
    expect(consumeAuthReturnTo()).toBeNull();
    expect(sessionStorage.getItem("findback.authReturnTo")).toBeNull();
  });

  it("clearAuthReturnTo drops a pending route", () => {
    rememberAuthReturnTo("/posts/drop");
    clearAuthReturnTo();
    expect(consumeAuthReturnTo()).toBeNull();
  });
});
