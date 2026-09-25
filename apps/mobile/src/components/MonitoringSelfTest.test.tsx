// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MonitoringSelfTest } from "./MonitoringSelfTest";
import * as sentryModule from "../services/monitoring/sentry";

// Mock the sentry module
vi.mock("../services/monitoring/sentry", () => ({
  monitoringSelfTestEnabled: vi.fn(),
  sendMonitoringTestSignalAsync: vi.fn(),
  MONITORING_TEST_SIGNAL_TAG_VALUE: "findback-monitoring-self-test",
}));

const monitoringSelfTestEnabledMock = vi.mocked(sentryModule.monitoringSelfTestEnabled);
const sendMonitoringTestSignalAsyncMock = vi.mocked(sentryModule.sendMonitoringTestSignalAsync);

afterEach(cleanup);

describe("MonitoringSelfTest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders nothing when VITE_MONITORING_SELFTEST is not 'true'", () => {
    monitoringSelfTestEnabledMock.mockReturnValue(false);
    render(<MonitoringSelfTest />);
    expect(screen.queryByText("Monitoring Self-Test")).toBeNull();
    expect(screen.queryByRole("button", { name: /send monitoring test signal/i })).toBeNull();
  });

  it("renders nothing when VITE_MONITORING_SELFTEST is undefined", () => {
    monitoringSelfTestEnabledMock.mockReturnValue(false);
    render(<MonitoringSelfTest />);
    expect(screen.queryByText("Monitoring Self-Test")).toBeNull();
  });

  it("renders the control when VITE_MONITORING_SELFTEST is 'true'", () => {
    monitoringSelfTestEnabledMock.mockReturnValue(true);
    sendMonitoringTestSignalAsyncMock.mockResolvedValue(null);
    render(<MonitoringSelfTest />);
    expect(screen.getByText("Monitoring Self-Test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /send monitoring test signal/i })).toBeTruthy();
    expect(screen.getByText(/tap to send a synthetic monitoring signal/i)).toBeTruthy();
    // The tag appears in the description - that's expected
    expect(screen.getByText("findback-monitoring-self-test")).toBeTruthy();
  });

  it("calls sendMonitoringTestSignalAsync on button tap and shows event ID on success", async () => {
    monitoringSelfTestEnabledMock.mockReturnValue(true);
    sendMonitoringTestSignalAsyncMock.mockResolvedValue("test-event-id-123");
    render(<MonitoringSelfTest />);

    const button = screen.getByRole("button", { name: /send monitoring test signal/i });
    fireEvent.click(button);

    // Should show sending state
    expect(screen.getByText("Sending…")).toBeTruthy();

    // Wait for success state
    await waitFor(() => {
      expect(screen.getByText("✓ Test signal sent")).toBeTruthy();
    });

    // Query the code element for the event ID (unique)
    await waitFor(() => {
      const eventIdCode = screen.getByText("test-event-id-123");
      expect(eventIdCode).toBeTruthy();
    });
    // The tag appears twice (description + result), verify both exist
    await waitFor(() => {
      const tagCodes = screen.getAllByText("findback-monitoring-self-test");
      expect(tagCodes.length).toBeGreaterThanOrEqual(2);
    });
    expect(sendMonitoringTestSignalAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("shows honest error when monitoring is not initialized (returns null)", async () => {
    monitoringSelfTestEnabledMock.mockReturnValue(true);
    sendMonitoringTestSignalAsyncMock.mockResolvedValue(null);
    render(<MonitoringSelfTest />);

    const button = screen.getByRole("button", { name: /send monitoring test signal/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("✗ Monitoring not initialized (no DSN). Enable Sentry to send test signal.")).toBeTruthy();
    });

    // The tag appears twice (description + error result)
    await waitFor(() => {
      const tagCodes = screen.getAllByText("findback-monitoring-self-test");
      expect(tagCodes.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows honest error when sendMonitoringTestSignalAsync throws", async () => {
    monitoringSelfTestEnabledMock.mockReturnValue(true);
    sendMonitoringTestSignalAsyncMock.mockRejectedValue(new Error("Network error"));
    render(<MonitoringSelfTest />);

    const button = screen.getByRole("button", { name: /send monitoring test signal/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("✗ Network error")).toBeTruthy();
    });

    // The tag appears twice (description + error result)
    await waitFor(() => {
      const tagCodes = screen.getAllByText("findback-monitoring-self-test");
      expect(tagCodes.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("button is disabled while sending", async () => {
    monitoringSelfTestEnabledMock.mockReturnValue(true);
    let resolveFn: (value: string | null) => void;
    const promise = new Promise<string | null>((resolve) => {
      resolveFn = resolve;
    });
    sendMonitoringTestSignalAsyncMock.mockReturnValue(promise);
    render(<MonitoringSelfTest />);

    const button = screen.getByRole("button", { name: /send monitoring test signal/i }) as HTMLButtonElement;
    fireEvent.click(button);

    expect(button.disabled).toBe(true);
    expect(screen.getByText("Sending…")).toBeTruthy();

    resolveFn!("event-id-456");
    await waitFor(() => {
      const eventIdCode = screen.getByText("event-id-456");
      expect(eventIdCode).toBeTruthy();
    });
  });
});