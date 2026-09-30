// @vitest-environment node
import { describe, expect, it } from "vitest";
import { feedFilterKey } from "./feedCache";

describe("feedFilterKey nearby separation", () => {
  it("separates nearby on from off", () => {
    const off = feedFilterKey({ type: "LOST" });
    const on = feedFilterKey({ type: "LOST", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 });
    expect(on).not.toBe(off);
  });

  it("separates radii", () => {
    const r10 = feedFilterKey({ type: "LOST", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 });
    const r5 = feedFilterKey({ type: "LOST", nearLat: 12.346, nearLng: 77.654, radiusM: 5_000 });
    expect(r10).not.toBe(r5);
  });

  it("separates rounded centers but shares one ~100 m cell", () => {
    const a = feedFilterKey({ type: "", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 });
    const sameCell = feedFilterKey({ type: "", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 });
    const far = feedFilterKey({ type: "", nearLat: 13.0, nearLng: 77.654, radiusM: 10_000 });
    expect(sameCell).toBe(a);
    expect(far).not.toBe(a);
  });

  it("combines with type/status/dateFrom without collisions", () => {
    const lostNearby = feedFilterKey({
      type: "LOST", status: "OPEN", dateFrom: "2026-09-23",
      nearLat: 12.346, nearLng: 77.654, radiusM: 10_000,
    });
    const foundNearby = feedFilterKey({
      type: "FOUND", status: "OPEN", dateFrom: "2026-09-23",
      nearLat: 12.346, nearLng: 77.654, radiusM: 10_000,
    });
    const lostRecent = feedFilterKey({ type: "LOST", status: "OPEN", dateFrom: "2026-09-23" });
    expect(lostNearby).not.toBe(foundNearby);
    expect(lostNearby).not.toBe(lostRecent);
  });
});
