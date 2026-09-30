// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEARBY_RADIUS_KM,
  NEARBY_RADIUS_OPTIONS_KM,
  NEARBY_SHEET_NOTICE,
  RECENT_DAYS,
  clearNearbySession,
  getNearbySession,
  kmToMeters,
  nearbyCenterFingerprint,
  parseNearbyRadiusParam,
  recentCutoffDate,
  roundNearbyCenter,
  setNearbySession,
} from "./nearby";

import { clearUserScopedLocalState } from "./userScopedState";

describe("nearby discovery helpers", () => {
  it("defaults to a 10 km radius with 2/5/10/25/50 km options", () => {
    expect(DEFAULT_NEARBY_RADIUS_KM).toBe(10);
    expect([...NEARBY_RADIUS_OPTIONS_KM]).toEqual([2, 5, 10, 25, 50]);
  });

  it("converts radius km to meters", () => {
    expect(kmToMeters(10)).toBe(10_000);
    expect(kmToMeters(2)).toBe(2_000);
    expect(kmToMeters(50)).toBe(50_000);
  });

  it("rounds the search center to ~100 m (3 decimals) before querying", () => {
    expect(roundNearbyCenter(12.34567, 77.65432)).toEqual({ lat: 12.346, lng: 77.654 });
    expect(roundNearbyCenter(12.34544, 77.65444)).toEqual({ lat: 12.345, lng: 77.654 });
  });

  it("fingerprints the rounded center plus radius for cache identity", () => {
    const a = nearbyCenterFingerprint({ lat: 12.346, lng: 77.654 }, 10_000);
    // Same ~100 m cell (unrounded inputs) shares the fingerprint.
    const b = nearbyCenterFingerprint(roundNearbyCenter(12.34604, 77.65404), 10_000);
    expect(b).toBe(a);
    // A different radius separates the cache.
    expect(nearbyCenterFingerprint({ lat: 12.346, lng: 77.654 }, 5_000)).not.toBe(a);
    // A far center separates the cache.
    expect(nearbyCenterFingerprint({ lat: 13.0, lng: 77.654 }, 10_000)).not.toBe(a);
  });

  it("computes Recent as the last 7 days for dateFrom", () => {
    expect(RECENT_DAYS).toBe(7);
    expect(recentCutoffDate(7, new Date("2026-09-30T12:00:00.000Z"))).toBe("2026-09-23");
  });

  it("parses only the allowed radius values from the `near` URL param", () => {
    expect(parseNearbyRadiusParam("10")).toBe(10);
    expect(parseNearbyRadiusParam("2")).toBe(2);
    expect(parseNearbyRadiusParam("50")).toBe(50);
    expect(parseNearbyRadiusParam("7")).toBeNull();
    expect(parseNearbyRadiusParam("")).toBeNull();
    expect(parseNearbyRadiusParam(null)).toBeNull();
    expect(parseNearbyRadiusParam("12.346")).toBeNull();
  });

  it("tells the user typed-place-only reports are excluded from Nearby", () => {
    expect(NEARBY_SHEET_NOTICE).toBe(
      "Nearby uses reports with a map pin. Reports with only a typed place name are not included.",
    );
  });

  it("keeps the search center in private in-memory session state only", () => {
    clearNearbySession();
    expect(getNearbySession()).toEqual({ center: null, radiusKm: 10, active: false });
    setNearbySession({ center: { lat: 12.346, lng: 77.654 }, radiusKm: 5, active: true });
    expect(getNearbySession().active).toBe(true);
    expect(getNearbySession().center).toEqual({ lat: 12.346, lng: 77.654 });
    clearNearbySession();
    expect(getNearbySession()).toEqual({ center: null, radiusKm: 10, active: false });
  });

  it("logout drops the session center so the next account starts clean", () => {
    setNearbySession({ center: { lat: 12.346, lng: 77.654 }, radiusKm: 5, active: true });
    clearUserScopedLocalState();
    expect(getNearbySession()).toEqual({ center: null, radiusKm: 10, active: false });
  });
});
