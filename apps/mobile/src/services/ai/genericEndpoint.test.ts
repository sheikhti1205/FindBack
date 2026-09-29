/**
 * Generic endpoint configuration tests (h1-generic).
 *
 * Validation states the plain-HTTP policy explicitly, persistence is scoped
 * to one account, and no default endpoint is ever invented.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  GENERIC_ENDPOINT_MISSING_COPY,
  genericEndpointKey,
  loadGenericEndpoint,
  removeGenericEndpoint,
  saveGenericEndpoint,
  validateGenericEndpoint,
} from "./genericEndpoint";
import type { KeyValueStore } from "../storage";

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

let store: KeyValueStore;
beforeEach(() => {
  store = memoryStore();
});

describe("validateGenericEndpoint", () => {
  it("accepts an https endpoint and strips trailing slashes", () => {
    const checked = validateGenericEndpoint("https://api.example.com/v1/");
    expect(checked).toEqual({
      ok: true,
      endpoint: "https://api.example.com/v1",
      insecure: false,
    });
  });

  it("accepts plain http only for loopback hosts and flags it insecure", () => {
    for (const raw of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
      const checked = validateGenericEndpoint(raw);
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(checked.insecure).toBe(true);
    }
  });

  it("rejects plain http for non-loopback hosts with the explicit policy", () => {
    const checked = validateGenericEndpoint("http://api.example.com/v1");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error).toMatch(/plain http is rejected for non-loopback/i);
      expect(checked.error).toMatch(/https is required/i);
    }
  });

  it("rejects empty input with the missing-endpoint explanation", () => {
    const checked = validateGenericEndpoint("   ");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toBe(GENERIC_ENDPOINT_MISSING_COPY);
  });

  it("rejects non-http schemes and credentials in the URL without echoing them", () => {
    const secret = "s3cret-token";
    for (const raw of [`ftp://api.example.com/v1`, `https://user:${secret}@api.example.com/v1`]) {
      const checked = validateGenericEndpoint(raw);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.error).not.toContain(secret);
    }
  });
});

describe("generic endpoint persistence", () => {
  it("loads null when nothing was configured (no default is invented)", () => {
    expect(loadGenericEndpoint("acct-1", store)).toBeNull();
  });

  it("round-trips save/load/remove scoped to one account", () => {
    expect(saveGenericEndpoint("acct-1", "https://api.example.com/v1/", store)).toBe(
      "https://api.example.com/v1",
    );
    expect(loadGenericEndpoint("acct-1", store)).toBe("https://api.example.com/v1");
    removeGenericEndpoint("acct-1", store);
    expect(loadGenericEndpoint("acct-1", store)).toBeNull();
  });

  it("isolates endpoints between accounts", () => {
    saveGenericEndpoint("acct-1", "https://one.example.com/v1", store);
    saveGenericEndpoint("acct-2", "https://two.example.com/v1", store);
    expect(loadGenericEndpoint("acct-1", store)).toBe("https://one.example.com/v1");
    expect(loadGenericEndpoint("acct-2", store)).toBe("https://two.example.com/v1");
    removeGenericEndpoint("acct-1", store);
    expect(loadGenericEndpoint("acct-1", store)).toBeNull();
    expect(loadGenericEndpoint("acct-2", store)).toBe("https://two.example.com/v1");
  });

  it("refuses to persist invalid input and keeps the previous value", () => {
    saveGenericEndpoint("acct-1", "https://api.example.com/v1", store);
    expect(() => saveGenericEndpoint("acct-1", "http://api.example.com/v1", store)).toThrow(
      /non-loopback/i,
    );
    expect(loadGenericEndpoint("acct-1", store)).toBe("https://api.example.com/v1");
  });

  it("treats stored garbage as unconfigured and keys storage per account", () => {
    store.setItem(genericEndpointKey("acct-1"), "not a url");
    expect(loadGenericEndpoint("acct-1", store)).toBeNull();
    expect(genericEndpointKey("acct-1")).toContain(encodeURIComponent("acct-1"));
    expect(genericEndpointKey("acct-1")).not.toBe(genericEndpointKey("acct-2"));
  });
});
