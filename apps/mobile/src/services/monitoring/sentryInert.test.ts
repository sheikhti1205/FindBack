import { afterEach, describe, expect, it, vi } from "vitest";

// S1 build-contract proof: unit tests and DSN-free runs must never attempt
// telemetry. The Sentry SDK is mocked so any capture attempt would be observed.
vi.mock("@sentry/capacitor", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as SentryCapacitor from "@sentry/capacitor";
import {
  initMonitoring,
  reportErrorToMonitoring,
  reportLogToMonitoring,
  sendMonitoringTestSignal,
} from "./sentry";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("monitoring without VITE_SENTRY_DSN (S1 build contract)", () => {
  it("stays inert: init is a safe no-op, report is dropped, test signal returns false", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    expect(() => initMonitoring()).not.toThrow();
    expect(sendMonitoringTestSignal()).toBe(false);
    expect(() => reportErrorToMonitoring(new Error("boom"), { note: "x" })).not.toThrow();
    expect(() => reportLogToMonitoring("info", "hello", { note: "x" })).not.toThrow();
    expect(() => reportLogToMonitoring("warn", "hello")).not.toThrow();
    expect(() => reportLogToMonitoring("error", "hello")).not.toThrow();
    // Flush any queued microtasks; nothing may reach the SDK.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(SentryCapacitor.captureException).not.toHaveBeenCalled();
    expect(SentryCapacitor.captureMessage).not.toHaveBeenCalled();
    expect(SentryCapacitor.logger.info).not.toHaveBeenCalled();
    expect(SentryCapacitor.logger.warn).not.toHaveBeenCalled();
    expect(SentryCapacitor.logger.error).not.toHaveBeenCalled();
  });
});
