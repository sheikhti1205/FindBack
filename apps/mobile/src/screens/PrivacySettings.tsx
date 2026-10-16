import { useCallback, useEffect, useState } from "react";
import { Activity, Eye, MapPin, Sparkles } from "lucide-react";
import {
  PreferenceSwitchRow,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import {
  isDeviceLocationEnabled,
  isNativeLocationServicesAvailable,
  requestEnableDeviceLocation,
} from "../services/locationServices";
import { isDiagEnabled, setDiagEnabled } from "../services/diag";
import { resolveSentryDsn } from "../services/monitoring/sentry";
import "./PrivacySettings.css";

type LocationState = "checking" | "on" | "off" | "unknown";

/**
 * Settings → Privacy. Only real controls and real status: device location
 * services (native bridge), the public-sharing policy the app actually
 * follows, the real verbose-logging flag, and read-only crash-report status.
 * There is no precise/approximate toggle because no app logic supports one.
 */
export function PrivacySettings() {
  const [location, setLocation] = useState<LocationState>("checking");
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [verbose, setVerbose] = useState(() => isDiagEnabled());
  const [crashOn] = useState(() => resolveSentryDsn(import.meta.env.VITE_SENTRY_DSN) !== null);

  const refreshLocation = useCallback(async () => {
    setLocationError(null);
    try {
      const enabled = await isDeviceLocationEnabled();
      setLocation(enabled === true ? "on" : enabled === false ? "off" : "unknown");
    } catch {
      setLocation("unknown");
    }
  }, []);

  useEffect(() => {
    void refreshLocation();
  }, [refreshLocation]);

  const enableLocation = useCallback(async () => {
    setLocating(true);
    setLocationError(null);
    try {
      const enabled = await requestEnableDeviceLocation();
      if (enabled) {
        await refreshLocation();
      } else {
        setLocationError("Location services are still off. You can type a place instead.");
      }
    } catch {
      setLocationError("Location services could not be reached. You can type a place instead.");
    } finally {
      setLocating(false);
    }
  }, [refreshLocation]);

  const toggleVerbose = useCallback((value: boolean) => {
    setDiagEnabled(value);
    setVerbose(value);
  }, []);

  const canEnable = isNativeLocationServicesAvailable() && location === "off";

  return (
    <SettingsPage
      title="Privacy"
      backTo="/settings"
      description="What FindBack knows about you, and the real switches that control it."
    >
      <SettingsGroup
        title="Location"
        description="FindBack reads your location once when you choose it on a report — never in the background."
      >
        <SettingsRow
          title="Location services"
          description={
            location === "checking"
              ? "Checking this device…"
              : location === "on"
                ? "Your device can share its location when you choose it."
                : location === "off"
                  ? "Turned off on this device. Reports can still use a typed place."
                  : "Not available on this device. Reports can still use a typed place."
          }
          icon={MapPin}
          iconTone="privacy"
          value={
            location === "checking" ? (
              <StatusPill tone="neutral">Checking…</StatusPill>
            ) : location === "on" ? (
              <StatusPill tone="success">On</StatusPill>
            ) : location === "off" ? (
              <StatusPill tone="warning">Off</StatusPill>
            ) : (
              <StatusPill tone="neutral">Unknown</StatusPill>
            )
          }
        />
        {canEnable ? (
          <SettingsRow
            title="Turn on location services"
            description="Opens your device prompt. Dismissing it keeps the typed-place fallback."
            icon={MapPin}
            iconTone="privacy"
            onClick={() => void enableLocation()}
            disabled={locating}
          />
        ) : null}
        {locationError ? (
          <p role="alert" className="fb-privacy-alert">
            {locationError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="What stays public"
        description="Report details you publish can be seen by other people."
      >
        <SettingsRow
          title="Approximate by default"
          description="Report locations default to an approximate area (~100 m). An exact pin is optional and is shown publicly."
          icon={Eye}
          iconTone="privacy"
        />
        <SettingsRow
          title="Photos stay on your device"
          description="Report photos stay on the device until you publish."
          icon={Eye}
          iconTone="privacy"
        />
      </SettingsGroup>

      <SettingsGroup title="Diagnostics & crash reports">
        <PreferenceSwitchRow
          title="Verbose diagnostic logging"
          description="Keeps redacted troubleshooting events on this device. Nothing is ever uploaded."
          icon={Activity}
          iconTone="privacy"
          checked={verbose}
          onChange={toggleVerbose}
        />
        <SettingsRow
          title="Crash reports"
          description={
            crashOn
              ? "On. Sends sanitized crash events only — no identity, no message text."
              : "Crash reporting is off in this build."
          }
          icon={Activity}
          iconTone="privacy"
          value={
            crashOn ? (
              <StatusPill tone="success">On</StatusPill>
            ) : (
              <StatusPill tone="neutral">Off</StatusPill>
            )
          }
        />
      </SettingsGroup>

      <SettingsGroup title="AI">
        <SettingsRow
          title="AI privacy"
          description="Your provider key stays on this device."
          icon={Sparkles}
          iconTone="ai"
          route="/ai-connection"
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
