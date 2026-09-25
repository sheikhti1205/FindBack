// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  COARSE_LOCATION_OPTIONS,
  LOW_ACCURACY_METERS,
  classifyGeolocationError,
  formatAccuracy,
  isLowAccuracy,
  locationFailureMessage,
  requestOneTimeLocation,
  type LocationFailureReason,
} from "./locationPermission";

type Success = (position: {
  coords: { latitude: number; longitude: number; accuracy?: number };
}) => void;
type Failure = (error: { code?: number; message?: string }) => void;

/** Geolocation double that only records what the app asked for. */
function recordingGeolocation() {
  const pending: Array<{ success: Success; failure: Failure; options?: PositionOptions }> = [];
  const getCurrentPosition = vi.fn(
    (success: Success, failure: Failure, options?: PositionOptions) => {
      pending.push({ success, failure, options });
    },
  );
  const geo = { getCurrentPosition } as unknown as Geolocation;
  return { geo, getCurrentPosition, pending };
}

/** Takes the oldest unanswered request so tests never index blindly. */
function take<T>(list: T[]): T {
  const item = list.shift();
  if (!item) throw new Error("no location request in flight");
  return item;
}

const ALL_FAILURES: LocationFailureReason[] = [
  "denied",
  "disabled",
  "timeout",
  "unavailable",
  "unsupported",
];

describe("location permission facade", () => {
  it("reports a granted fix rounded to 6 decimals with the reported accuracy kept", async () => {
    const { geo, pending } = recordingGeolocation();
    const request = requestOneTimeLocation(geo);
    take(pending).success({
      coords: { latitude: 23.8103321, longitude: 90.4125189, accuracy: 42 },
    });
    await expect(request).resolves.toEqual({
      status: "granted",
      latitude: 23.810332,
      longitude: 90.412519,
      accuracyMeters: 42,
    });
  });

  it("keeps a missing accuracy as unknown instead of inventing one", async () => {
    const { geo, pending } = recordingGeolocation();
    const request = requestOneTimeLocation(geo);
    take(pending).success({ coords: { latitude: 1, longitude: 2 } });
    await expect(request).resolves.toEqual({
      status: "granted",
      latitude: 1,
      longitude: 2,
      accuracyMeters: null,
    });
  });

  it("classifies denied, services-off and timeout from the platform error code", async () => {
    const cases: Array<[unknown, LocationFailureReason]> = [
      [{ code: 1 }, "denied"],
      [{ code: 2 }, "disabled"],
      [{ code: 3 }, "timeout"],
      [{ message: "no code" }, "unavailable"],
      [null, "unavailable"],
    ];
    for (const [error, expected] of cases) {
      expect(classifyGeolocationError(error)).toBe(expected);
    }

    const { geo, pending } = recordingGeolocation();
    const denied = requestOneTimeLocation(geo);
    take(pending).failure({ code: 1 });
    await expect(denied).resolves.toEqual({ status: "denied" });
  });

  it("gives every failure its own distinct, actionable copy", () => {
    const messages = ALL_FAILURES.map((reason) => locationFailureMessage(reason));
    expect(new Set(messages).size).toBe(ALL_FAILURES.length);
    expect(locationFailureMessage("denied")).toMatch(/permission is denied/i);
    expect(locationFailureMessage("disabled")).toMatch(/location services are off/i);
    expect(locationFailureMessage("timeout")).toMatch(/within 8 seconds/i);
    expect(locationFailureMessage("unavailable")).toMatch(/unavailable right now/i);
    expect(locationFailureMessage("unsupported")).toMatch(/not supported/i);
    for (const message of messages) {
      expect(message).toMatch(/type a place instead|try again/i);
    }
  });

  it("reports a missing geolocation API as unsupported without prompting", async () => {
    await expect(requestOneTimeLocation(null)).resolves.toEqual({ status: "unsupported" });
  });

  it("reports a synchronous platform throw as unavailable, never as granted", async () => {
    const throwing = {
      getCurrentPosition: vi.fn(() => {
        throw new Error("geolocation blew up");
      }),
    } as unknown as Geolocation;
    await expect(requestOneTimeLocation(throwing)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("asks for a coarse fix only — never a precise one", async () => {
    const { geo, getCurrentPosition, pending } = recordingGeolocation();
    const request = requestOneTimeLocation(geo);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(getCurrentPosition.mock.calls[0]?.[2]).toEqual(COARSE_LOCATION_OPTIONS);
    expect(getCurrentPosition.mock.calls[0]?.[2]?.enableHighAccuracy).toBe(false);
    take(pending).failure({ code: 3 });
    await request;
  });

  it("collapses concurrent taps into a single platform prompt", async () => {
    const { geo, getCurrentPosition, pending } = recordingGeolocation();
    const first = requestOneTimeLocation(geo);
    const second = requestOneTimeLocation(geo);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    take(pending).success({ coords: { latitude: 1, longitude: 2, accuracy: 10 } });
    await expect(first).resolves.toEqual(
      expect.objectContaining({ status: "granted" }),
    );
    // The lock releases once settled, so a later explicit tap may ask again.
    const third = requestOneTimeLocation(geo);
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    take(pending).failure({ code: 1 });
    await third;
  });

  it("never prompts by itself — the facade only runs when it is called", () => {
    const { getCurrentPosition } = recordingGeolocation();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("flags a fix coarser than the ~100 m pin as low accuracy", () => {
    expect(isLowAccuracy(LOW_ACCURACY_METERS)).toBe(false);
    expect(isLowAccuracy(LOW_ACCURACY_METERS + 1)).toBe(true);
    expect(isLowAccuracy(4200)).toBe(true);
    expect(isLowAccuracy(42)).toBe(false);
    expect(isLowAccuracy(null)).toBe(false);
    expect(isLowAccuracy(Number.NaN)).toBe(false);
    expect(isLowAccuracy(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("formats accuracy for people", () => {
    expect(formatAccuracy(42)).toBe("~42 m");
    expect(formatAccuracy(4200)).toBe("~4.2 km");
  });
});
