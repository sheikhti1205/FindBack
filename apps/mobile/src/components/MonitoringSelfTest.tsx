import { useState } from "react";
import type { ReactElement } from "react";
import { Button } from "./Button";
import {
  monitoringSelfTestEnabled,
  sendMonitoringTestSignalAsync,
  MONITORING_TEST_SIGNAL_TAG_VALUE,
} from "../services/monitoring/sentry";

/**
 * One-tap monitoring self-test trigger for device verification.
 * Only renders when VITE_MONITORING_SELFTEST === "true".
 * Shows a 48dp accessible button and displays the outcome including
 * the Sentry event ID and fixed tag for owner verification.
 */
function MonitoringSelfTestBody(): ReactElement {
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [eventId, setEventId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSend = async () => {
    setStatus("sending");
    setEventId(null);
    setErrorMessage(null);

    try {
      const id = await sendMonitoringTestSignalAsync();
      if (id) {
        setEventId(id);
        setStatus("success");
      } else {
        setErrorMessage("Monitoring not initialized (no DSN). Enable Sentry to send test signal.");
        setStatus("error");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  };

  return (
    <section
      className="flex flex-col gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low p-4"
      aria-labelledby="monitoring-self-test-heading"
    >
      <h2 id="monitoring-self-test-heading" className="text-sm font-medium">
        Monitoring Self-Test
      </h2>
      <p className="text-xs text-on-surface-variant">
        Tap to send a synthetic monitoring signal to Sentry. The event carries the fixed tag
        <code className="px-1 rounded bg-surface-container-highest">{MONITORING_TEST_SIGNAL_TAG_VALUE}</code>
        so you can find it in Sentry.
      </p>
      <Button
        variant="outline"
        disabled={status === "sending"}
        onClick={handleSend}
        aria-label="Send monitoring test signal"
        className="min-h-[48px] min-w-[48px]"
      >
        {status === "sending" ? "Sending…" : "Send Test Signal"}
      </Button>
      {status === "success" && (
        <div className="flex flex-col gap-1 text-xs text-on-surface-variant">
          <span className="text-green-600 dark:text-green-400">✓ Test signal sent</span>
          <span>
            Event ID: <code className="font-mono">{eventId}</code>
          </span>
          <span>
            Tag: <code className="font-mono">{MONITORING_TEST_SIGNAL_TAG_VALUE}</code>
          </span>
        </div>
      )}
      {status === "error" && (
        <div className="flex flex-col gap-1 text-xs text-red-600 dark:text-red-400">
          <span>✗ {errorMessage}</span>
          <span>
            Tag would be: <code className="font-mono">{MONITORING_TEST_SIGNAL_TAG_VALUE}</code>
          </span>
        </div>
      )}
    </section>
  );
}

export function MonitoringSelfTest(): ReactElement | null {
  if (!monitoringSelfTestEnabled(import.meta.env as { VITE_MONITORING_SELFTEST?: string })) {
    return null;
  }
  return <MonitoringSelfTestBody />;
}