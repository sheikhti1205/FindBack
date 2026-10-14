/**
 * W-E — Google failure-class taxonomy pins.
 *
 * The consumer copy below is a product contract: stable categories only, no
 * raw provider internals, no token/nonce material, no device-blaming
 * language. Every class maps the exact native/exchange signal in the table
 * at the top of `googleFailureClasses.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  GOOGLE_FAILURE_COPY,
  NATIVE_EXCEPTION_CLASS_TABLE,
  classifyExchangeError,
  classifyNativeKind,
  isGoogleFailureClass,
} from "./googleFailureClasses";

describe("googleFailureClasses — class set", () => {
  it("covers the six consumer categories plus silent cancel and rate-limit wait", () => {
    for (const cls of [
      "setup_unavailable",
      "no_account",
      "device_unsupported",
      "network",
      "cancelled_silent",
      "provider_rejected",
      "rate_limited",
      "try_again",
    ] as const) {
      expect(isGoogleFailureClass(cls)).toBe(true);
    }
    expect(isGoogleFailureClass("GetCredentialProviderConfigurationException")).toBe(false);
    expect(isGoogleFailureClass(undefined)).toBe(false);
    expect(isGoogleFailureClass(null)).toBe(false);
  });

  it("consumer copy never leaks internals, tokens, or device blame", () => {
    for (const copy of Object.values(GOOGLE_FAILURE_COPY)) {
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/device/i);
      expect(copy).not.toMatch(/exception|PGRST|aud\b|nonce|token|secret|client.?id/i);
    }
  });
});

describe("NATIVE_EXCEPTION_CLASS_TABLE — exact exception-class capture", () => {
  it("maps every Credential Manager failure class from the closure matrix", () => {
    expect(NATIVE_EXCEPTION_CLASS_TABLE).toMatchObject({
      GetCredentialProviderConfigurationException: "setup_unavailable",
      NoCredentialException: "no_account",
      GetCredentialUnsupportedException: "device_unsupported",
      GetCredentialCancellationException: "cancelled_silent",
      GetCredentialInterruptedException: "cancelled_silent",
      IOException: "network",
    });
  });
});

describe("classifyNativeKind — S1 kinds onto classes", () => {
  it.each([
    ["cancelled", "cancelled_silent"],
    ["misconfigured", "setup_unavailable"],
    ["unavailable", "no_account"],
    ["no_credential", "no_account"],
    ["network", "network"],
    ["network_error", "network"],
    ["unknown", "try_again"],
    ["something_new", "try_again"],
  ] as const)("maps S1 kind %s to class %s", (kind, cls) => {
    expect(classifyNativeKind(kind)).toBe(cls);
  });

  it("passes S2-attached classes through and never throws", () => {
    expect(classifyNativeKind("provider_rejected")).toBe("provider_rejected");
    expect(classifyNativeKind(undefined)).toBe("try_again");
    expect(classifyNativeKind({})).toBe("try_again");
  });
});

describe("classifyExchangeError — Supabase/transport rejections", () => {
  it("maps rate-limit signals to rate_limited", () => {
    expect(classifyExchangeError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyExchangeError({ message: "Too many requests" })).toBe("rate_limited");
  });

  it("maps provider-enablement signals to setup_unavailable (console-side)", () => {
    expect(classifyExchangeError({ code: "provider_disabled" })).toBe("setup_unavailable");
    expect(classifyExchangeError({ message: "Unsupported provider" })).toBe("setup_unavailable");
  });

  it("maps transport failures to network, including TypeError fetch aborts", () => {
    expect(classifyExchangeError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyExchangeError({ message: "Network request failed" })).toBe("network");
  });

  it("maps token-ok-but-rejected signals to provider_rejected", () => {
    expect(classifyExchangeError({ code: "invalid_jwt_xyz", message: "JWT aud mismatch" })).toBe(
      "provider_rejected",
    );
    expect(classifyExchangeError({ code: "invalid_grant", message: "code expired" })).toBe(
      "provider_rejected",
    );
    expect(classifyExchangeError({ message: "nonce mismatch" })).toBe("provider_rejected");
  });

  it("falls back to try_again for anything unrecognized", () => {
    expect(classifyExchangeError({})).toBe("try_again");
    expect(classifyExchangeError(null)).toBe("try_again");
    expect(classifyExchangeError("boom")).toBe("try_again");
  });
});
