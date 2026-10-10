// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  isGoogleMapsConfigured,
  resolveGoogleMapsConfig,
} from "./googleMapsConfig";

describe("googleMapsConfig", () => {
  it("resolves an empty key by default (fail-closed, never throws)", () => {
    const config = resolveGoogleMapsConfig();
    expect(typeof config.apiKey).toBe("string");
    // No key is baked into the test env: the maps layer must stay unavailable.
    expect(config.apiKey).toBe("");
    expect(isGoogleMapsConfigured(config)).toBe(false);
    expect(isGoogleMapsConfigured()).toBe(false);
  });

  it("recognizes a configured key without exposing it beyond the value", () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-key");
    try {
      const config = resolveGoogleMapsConfig();
      expect(config.apiKey).toBe("test-key");
      expect(isGoogleMapsConfigured(config)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats whitespace-only keys as missing", () => {
    expect(isGoogleMapsConfigured({ apiKey: "   " })).toBe(false);
  });
});
