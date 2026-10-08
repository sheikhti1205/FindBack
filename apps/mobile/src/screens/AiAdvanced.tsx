import { useState, useSyncExternalStore } from "react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import {
  AdvancedDisclosure,
  SettingsGroup,
  SettingsPage,
} from "../components/settings";
import { aiCredentials, SUPPORTED_AI_PROVIDERS } from "../services/aiCredentials";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";
import {
  DOWNLOAD_MODELS,
  getApplicationAi,
  type ApplicationAiService,
} from "../services/ai/applicationAi";
import type { ProbeContext, ProbeRecord } from "../services/ai/deviceProbe";
import type { OfflineModelStatus } from "../services/ai/offlineModelManager";
import { profileFor } from "../services/ai/modelProfiles";
import {
  canShowAuto,
  canShowGpu,
  canShowNeedle,
  canShowOffline,
  type NeedleEvidence,
} from "../services/ai/uiGates";
import {
  getAutoCapabilityCopy,
  getGpuCapabilityCopy,
  getNeedleCapabilityCopy,
  getOfflineCapabilityCopy,
  type MeasuredCapabilityFlags,
} from "../services/appCapabilities";
import { exportDiagJson } from "../services/diag";
import { BYOK_LABELS } from "./AiConnection";
import { EXPERIMENTAL_PROVIDER_NOTICE, experimentalProvidersEnabled, isProviderEnabled, setExperimentalProvidersEnabled } from "../services/ai/providerStatus";

export type AiAdvancedProps = {
  readonly service?: ApplicationAiService;
  readonly accountId?: string;
  /** Measured-evidence overrides (borrowed shapes, never owned logic). */
  readonly probeRecords?: readonly ProbeRecord[] | null;
  readonly probeContext?: ProbeContext | null;
  readonly offlineStatus?: OfflineModelStatus | null;
  readonly needleEvidence?: NeedleEvidence | null;
  /**
   * User-triggered diagnostics export seam. Defaults to the redacted
   * `exportDiagJson` ring export; tests inject a mock. Nothing is uploaded.
   */
  readonly exportDiagnostics?: () => string;
};

type ProbeState = {
  phase: "idle" | "testing" | "ready" | "error";
  notice: string | null;
};

const IDLE_PROBE: ProbeState = { phase: "idle", notice: null };

/**
 * Phase A.4: derive the offline-model status from the live service when
 * no test override is passed. Production renders `<AiAdvanced />` with no
 * `offlineStatus`, so the gate must read the manager (which knows the
 * installed + checksum-verified models) instead of asking
 * `canShowOffline(null)` — which always hides. An explicitly passed
 * status (including tests) still wins.
 */
function offlineStatusFromService(service: ApplicationAiService): OfflineModelStatus | null {
  for (const model of DOWNLOAD_MODELS) {
    const status = service.manager.statusOf(model.modelId);
    if (status !== undefined && status.download === "installed" && status.checksumVerified === true) {
      return status;
    }
  }
  return null;
}

/**
 * Advanced diagnostics (`/settings/ai/advanced`). The only consumer tier
 * where exact technical values (model ids, revisions, checksums, raw probe
 * data, provider test output) may appear. All actions reuse the existing
 * seams: `ApplicationAiService` for measure/inspect, the provider registry
 * for provider tests, and the redacted diagnostics export.
 */
export function AiAdvanced({
  service = getApplicationAi(),
  accountId,
  probeRecords,
  probeContext,
  offlineStatus = null,
  needleEvidence = null,
  exportDiagnostics = exportDiagJson,
}: AiAdvancedProps) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";
  const [, refreshExperimental] = useState(0);
  const experimental = experimentalProvidersEnabled(account);
  const [measuring, setMeasuring] = useState(false);
  const [perfNotice, setPerfNotice] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [diagNotice, setDiagNotice] = useState<string | null>(null);

  const records = probeRecords ?? service.probeRecords;
  const context = probeContext ?? service.probeContext;
  const effectiveOfflineStatus = offlineStatus ?? offlineStatusFromService(service);
  const measuredFlags: MeasuredCapabilityFlags = {
    hasFreshAutoProbe: canShowAuto(records, context),
    hasVerifiedOfflineModel: canShowOffline(effectiveOfflineStatus),
    hasNeedleEvidence: canShowNeedle(needleEvidence),
    hasFreshGpuProbe: canShowGpu(records, context),
  };
  const autoCopy = getAutoCapabilityCopy(measuredFlags).join(" ");
  const offlineCopy = getOfflineCapabilityCopy(measuredFlags).join(" ");
  const needleCopy = getNeedleCapabilityCopy(measuredFlags).join(" ");
  const gpuCopy = getGpuCapabilityCopy(measuredFlags).join(" ");

  async function measure(backend: "cpu" | "gpu") {
    if (measuring) return;
    setMeasuring(true);
    setPerfNotice("Measuring installed SmolVLM2. No sample is assumed.");
    try {
      const record = await service.measure(backend);
      setPerfNotice(
        `${backend.toUpperCase()}: TTFT ${record.ttftMs.toFixed(1)} ms; ${record.tokensPerSec.toFixed(2)} tokens/s; correctness ${record.correctnessPass ? "PASS" : "FAIL"}.`,
      );
    } catch (error) {
      setPerfNotice(error instanceof Error ? error.message : "Measurement unavailable.");
    } finally {
      setMeasuring(false);
    }
  }

  async function inspectHardware() {
    if (measuring) return;
    setMeasuring(true);
    setPerfNotice("Inspecting hardware…");
    try {
      const facts = await service.facts();
      setPerfNotice(JSON.stringify(facts));
    } catch (error) {
      setPerfNotice(error instanceof Error ? error.message : "Hardware inspection unavailable.");
    } finally {
      setMeasuring(false);
    }
  }

  async function testProvider(provider: (typeof SUPPORTED_AI_PROVIDERS)[number]) {
    if (!isProviderEnabled(account, provider)) return;
    if (busyProvider !== null) return;
    const controller = new AbortController();
    setBusyProvider(provider);
    setProbes((prev) => ({ ...prev, [provider]: { phase: "testing", notice: null } }));
    try {
      const adapter = createProviderAdapter(provider, {
        accountId: account,
        resolveKey: (id, slot) => aiCredentials.get(id, slot),
        genericBaseURL: loadGenericEndpoint(account) ?? undefined,
        resolveGenericEndpoint: (id) => loadGenericEndpoint(id),
      });
      const list = adapter.listModels;
      if (list === undefined) {
        setProbes((prev) => ({
          ...prev,
          [provider]: {
            phase: "error",
            notice: `${BYOK_LABELS[provider as keyof typeof BYOK_LABELS] ?? provider} has no list endpoint on this build; sends still use your saved key.`,
          },
        }));
        return;
      }
      const rows = await list(controller.signal);
      if (controller.signal.aborted) return;
      setProbes((prev) => ({
        ...prev,
        [provider]: {
          phase: "ready",
          notice:
            rows.length === 0
              ? `${BYOK_LABELS[provider as keyof typeof BYOK_LABELS] ?? provider} answered, but listed no models for this key.`
              : `${BYOK_LABELS[provider as keyof typeof BYOK_LABELS] ?? provider} answered and listed ${rows.length} ${rows.length === 1 ? "model" : "models"} for this key.`,
        },
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error && error.message.trim() !== "" ? error.message : "The test failed. Try again.";
      setProbes((prev) => ({
        ...prev,
        [provider]: { phase: "error", notice: message.slice(0, 300) },
      }));
    } finally {
      if (!controller.signal.aborted) setBusyProvider(null);
    }
  }

  function handleExportDiagnostics() {
    try {
      const payload = exportDiagnostics();
      let count = 0;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (Array.isArray(parsed)) count = parsed.length;
      } catch {
        count = 0;
      }
      setDiagNotice(
        `Exported ${count} ${count === 1 ? "event" : "events"} (redacted). Nothing was uploaded.`,
      );
      try {
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "findback-diag.json";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch {
        // Download is best effort; the export payload + notice already
        // confirm the user-triggered export happened.
      }
    } catch {
      setDiagNotice("Could not export diagnostics. Try again.");
    }
  }

  return (
    <SettingsPage
      title="Advanced"
      description="Performance tests and exact technical details for this phone."
      backTo="/settings/ai"
      backLabel="Back to AI & intelligence"
    >
      <SettingsGroup
        title="Device performance"
        description="Speed tests run on this phone only. Nothing is uploaded."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!service.android || measuring}
            title={service.android ? undefined : "On-device measurement requires the Android app."}
            onClick={() => void measure("cpu")}
          >
            {measuring ? "Measuring…" : "Measure CPU"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!service.android || measuring}
            title={service.android ? undefined : "On-device measurement requires the Android app."}
            onClick={() => void measure("gpu")}
          >
            {measuring ? "Measuring…" : "Measure GPU"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!service.android || measuring}
            title={service.android ? undefined : "Hardware inspection requires the Android app."}
            onClick={() => void inspectHardware()}
          >
            Inspect hardware
          </Button>
        </div>
        {!service.android ? (
          <p role="note" className="text-sm text-on-surface-variant">
            Device measurements require the Android app.
          </p>
        ) : null}
        {perfNotice !== null ? (
          <p role="status" className="text-sm wrap-break-word">
            {perfNotice}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="On-device measurements">
        <div data-testid="ai-gate-auto" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Automatic: </span>{autoCopy}
        </div>
        <div data-testid="ai-gate-offline" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Offline: </span>{offlineCopy}
        </div>
        <div data-testid="ai-gate-needle" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Needle: </span>{needleCopy}
        </div>
        <div data-testid="ai-gate-gpu" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">GPU: </span>{gpuCopy}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Model details">
        {DOWNLOAD_MODELS.map((model) => {
          const profile = profileFor(model.modelId);
          const status = service.manager.statusOf(model.modelId);
          return (
            <article key={model.modelId} aria-label={`Technical details for ${model.modelId}`} className="flex flex-col gap-1 py-2">
              <h3 className="text-sm font-semibold wrap-break-word">{model.modelId}</h3>
              <dl className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
                <div className="flex gap-2">
                  <dt className="font-medium text-on-surface">File:</dt>
                  <dd className="wrap-break-word">{model.fileName}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-on-surface">Size:</dt>
                  <dd>{model.bytes.toLocaleString()} bytes</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-on-surface">Revision:</dt>
                  <dd className="wrap-break-word">{profile?.revision ?? "unknown"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium text-on-surface">State:</dt>
                  <dd>
                    {status?.download ?? "not-installed"}
                    {status?.checksumVerified === true ? " · checksum verified" : ""}
                  </dd>
                </div>
              </dl>
              <AdvancedDisclosure title="Checksum">
                <p className="text-xs wrap-break-word">
                  SHA-256: {profile?.modelSha256 ?? "unknown"}
                </p>
              </AdvancedDisclosure>
            </article>
          );
        })}
      </SettingsGroup>

      <SettingsGroup
        title="Provider tests"
        description="Catalogue checks with your saved key. Some adapters return static rows; these checks are not real-send proof."
      >
        <label className="flex min-h-[48px] items-center gap-3 text-sm">
          <input type="checkbox" checked={experimental} aria-describedby="advanced-experimental-notice" disabled={busyProvider !== null} onChange={(event) => {
            setExperimentalProvidersEnabled(account, event.target.checked);
            refreshExperimental((value) => value + 1);
          }} />
          Experimental providers
        </label>
        <p id="advanced-experimental-notice" className="text-xs text-on-surface-variant">{EXPERIMENTAL_PROVIDER_NOTICE}</p>
        <ul className="flex flex-col gap-2">
          {SUPPORTED_AI_PROVIDERS.filter((provider) => isProviderEnabled(account, provider)).map((provider) => {
            const probe = probes[provider] ?? IDLE_PROBE;
            const label = BYOK_LABELS[provider as keyof typeof BYOK_LABELS] ?? provider;
            return (
              <li key={provider} data-testid={`ai-advanced-provider-${provider}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{label}</span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busyProvider !== null && busyProvider !== provider}
                    onClick={() => void testProvider(provider)}
                  >
                    {busyProvider === provider ? "Testing…" : `Test ${label}`}
                  </Button>
                </div>
                {probe.notice !== null ? (
                  <p
                    aria-live="polite"
                    className={probe.phase === "error" ? "text-sm text-error" : "text-sm"}
                  >
                    {probe.notice}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SettingsGroup>

      <SettingsGroup
        title="Diagnostics"
        description="Diagnostic export is manual and redacted. Nothing is uploaded; the file stays with you."
      >
        <div>
          <Button type="button" variant="outline" onClick={handleExportDiagnostics}>
            Export diagnostics
          </Button>
        </div>
        {diagNotice !== null ? (
          <p role="status" data-testid="ai-diag-export-status" className="text-sm">
            {diagNotice}
          </p>
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  );
}
