import { beforeEach, describe, expect, it, vi } from "vitest";

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ logEvent: logEventMock }),
}));

import { clearDiagEvents, getDiagEvents, setDiagEnabled } from "../../diag";
import {
  isNeedleTelemetryEnabled,
  recordNeedleTelemetry,
  setNeedleTelemetryOptIn,
} from "./telemetryGate";

beforeEach(() => {
  logEventMock.mockReset();
  logEventMock.mockResolvedValue(undefined);
  setDiagEnabled(false);
  setNeedleTelemetryOptIn(false);
  clearDiagEvents();
});

describe("telemetryGate", () => {
  it("defaults OFF and records nothing", () => {
    expect(isNeedleTelemetryEnabled()).toBe(false);
    expect(recordNeedleTelemetry("needle.test", { ok: true })).toBe(false);
    expect(getDiagEvents()).toHaveLength(0);
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it("stays OFF when diag is enabled but opt-in is missing", () => {
    setDiagEnabled(true);
    expect(isNeedleTelemetryEnabled()).toBe(false);
    expect(recordNeedleTelemetry("needle.test", { ok: true })).toBe(false);
    expect(getDiagEvents()).toHaveLength(0);
  });

  it("stays OFF when opted in but diag is disabled (diag-gated)", () => {
    setNeedleTelemetryOptIn(true);
    expect(isNeedleTelemetryEnabled()).toBe(false);
    expect(recordNeedleTelemetry("needle.test", { ok: true })).toBe(false);
    expect(getDiagEvents()).toHaveLength(0);
  });

  it("records a local diag event only with explicit opt-in plus diag", () => {
    setDiagEnabled(true);
    setNeedleTelemetryOptIn(true);
    expect(isNeedleTelemetryEnabled()).toBe(true);
    expect(recordNeedleTelemetry("needle.test", { ok: true })).toBe(true);
    expect(getDiagEvents()).toHaveLength(1);
    expect(getDiagEvents()[0]?.event).toBe("needle.test");
  });

  it("exposes no upload path (local ring only, fetch untouched)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setDiagEnabled(true);
    setNeedleTelemetryOptIn(true);
    recordNeedleTelemetry("needle.test", { ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
