import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Activity, Bot, Copy, FlaskConical, Info } from "lucide-react";
import {
  AdvancedDisclosure,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import { MonitoringSelfTest } from "../components/MonitoringSelfTest";
import { readBuildInfo, type BuildInfo } from "../services/buildInfo";
import { APP_VERSION, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "../services/appCapabilities";
import { isDiagEnabled, exportDiagBundle } from "../services/diag";
import { monitoringSelfTestEnabled } from "../services/monitoring/sentry";
import { pushController } from "../services/pushRuntime";
import type { PushPermissionState } from "../services/pushNotifications";
import "./Diagnostics.css";

function shortSha(sha: string | null | undefined): string {
  if (!sha || sha === "unknown") return "unknown";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
          }

/**
 * Settings → Diagnostics (Advanced). Read-only troubleshooting state:
 * monitoring self-test, build identifiers, notification/runtime state, and
 * a sanitized export that can only ever contain allowlisted identifiers —
 * never keys, tokens, or message text.
 */
export function Diagnostics() {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [permission, setPermission] = useState<PushPermissionState | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    readBuildInfo()
      .then((value) => {
        if (mounted) setInfo(value);
      })
      .catch(() => {
        if (mounted) setInfo(null);
      });
    pushController()
      .permission()
      .then((state) => {
        if (mounted) setPermission(state);
      })
      .catch(() => {
        if (mounted) setPermission(null);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const fullSha = info?.buildGitSha ?? null;
  const platform = Capacitor.isNativePlatform() ? "native" : "web";
  const verbose = isDiagEnabled();
  const selfTestAvailable = monitoringSelfTestEnabled(
    import.meta.env as { VITE_MONITORING_SELFTEST?: string },
  );

  const bundle = exportDiagBundle({
    buildSha: fullSha ?? undefined,
    probes: {
      push: permission ?? "unknown",
      platform,
      verbose: verbose,
    },
  });

  const copyBundle = useCallback(async () => {
    setCopied(false);
    setCopyError(null);
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        setCopyError("Copy isn't available here — the bundle text below can be selected manually.");
        return;
          }
      await clipboard.writeText(bundle);
      setCopied(true);
    } catch {
      setCopyError("Copy failed — the bundle text below can be selected manually.");
          }
  }, [bundle]);

  return (
    <SettingsPage
      title="Diagnostics"
      backTo="/settings"
      description="Advanced troubleshooting state. Everything here is read-only unless noted."
    >
      <SettingsGroup
        title="Monitoring self-test"
        description="Sends one clearly-labelled synthetic signal so an install can be verified."
      >
        {selfTestAvailable ? (
          <MonitoringSelfTest />
        ) : (
          <p className="fb-diagnostics-note">Monitoring self-test isn't enabled in this build.</p>
        )}
      </SettingsGroup>

      <SettingsGroup title="Build">
        <SettingsRow
          title="App version"
          icon={Info}
          iconTone="neutral"
          value={<span>{APP_VERSION}</span>}
        />
        <SettingsRow
          title="Build"
          description="Git revision this install was built from."
          icon={Info}
          iconTone="neutral"
          value={<span title={fullSha ?? undefined}>{shortSha(fullSha)}</span>}
        />
        <SettingsRow
          title="Version code"
          icon={Info}
          iconTone="neutral"
          value={            <span>
              {typeof info?.versionCode === "number" && info.versionCode > 0
                ? info.versionCode
                : "unknown"}
            </span>
          }
        />
        <SettingsRow
          title="Backend schema"
          icon={Info}
          iconTone="neutral"
          value={<span>{BACKEND_SCHEMA_VERSION}</span>}
        />
        <SettingsRow
          title="Capability schema"
          icon={Info}
          iconTone="neutral"
          value={<span>{CAPABILITIES_VERSION}</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="Runtime state">
        <SettingsRow
          title="App platform"
          icon={Activity}
          iconTone="neutral"
          value={            <StatusPill tone="neutral">{platform === "native" ? "Native app" : "Web"}</StatusPill>
          }
        />
        <SettingsRow
          title="Device notifications"
          description={`Device notifications: ${permission ?? "unknown"}. Change push categories in Settings → Notifications.`}
          icon={Activity}
          iconTone="neutral"
          value={            <StatusPill tone={permission === "granted" ? "success" : "neutral"}>
              {permission ?? "unknown"}
            </StatusPill>
          }
        />
        <SettingsRow
          title="Verbose logging"
          description="Toggle in Settings → Privacy."
          icon={Activity}
          iconTone="neutral"
          value={            <StatusPill tone={verbose ? "success" : "neutral"}>
              {verbose ? "On" : "Off"}
            </StatusPill>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="On-device AI">
        <SettingsRow
          title="AI & models"
          description="Installed models and measurements live here."
          icon={Bot}
          iconTone="ai"
          route="/ai-models"
        />
      </SettingsGroup>

      <SettingsGroup
        title="Sanitized export"
        description="A redacted bundle: build, permission, and platform state only. Never contains keys, tokens, or message text."
      >
        <SettingsRow
          title="Copy diagnostics"
          description="Copies the bundle below to the clipboard."
          icon={Copy}
          iconTone="neutral"
          onClick={() => void copyBundle()}
        />
        {copied ? (
          <p role="status" className="fb-diagnostics-note">
            Copied.
          </p>
        ) : null}
        {copyError ? (
          <p role="alert" className="fb-diagnostics-note">
            {copyError}
          </p>
        ) : null}
        <AdvancedDisclosure title="View bundle">
          <pre className="fb-diagnostics-bundle">{bundle}</pre>
        </AdvancedDisclosure>
      </SettingsGroup>

      <p className="fb-diagnostics-note">
        <FlaskConical size={14} aria-hidden="true" /> Nothing here leaves the device unless you
        copy it yourself.
      </p>
    </SettingsPage>
  );
          }
