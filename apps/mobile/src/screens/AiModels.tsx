import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { ModelCatalogSheet } from "../components/ModelCatalogSheet";
import { announce } from "../components/LiveRegion";
import { aiCredentials, SUPPORTED_AI_PROVIDERS } from "../services/aiCredentials";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { EXPERIMENTAL_PROVIDER_NOTICE, experimentalProvidersEnabled, isExperimentalProvider, isProviderEnabled, setExperimentalProvidersEnabled } from "../services/ai/providerStatus";
export { LIVE_TESTED_PROVIDERS, isExperimentalProvider } from "../services/ai/providerStatus";
import {
  GENERIC_ENDPOINT_MISSING_COPY,
  GENERIC_HTTP_LOOPBACK_COPY,
  GENERIC_HTTP_POLICY_COPY,
  loadGenericEndpoint,
  removeGenericEndpoint,
  saveGenericEndpoint,
} from "../services/ai/genericEndpoint";
import {
  loadAuthorizedCatalog,
  priceFingerprint,
} from "../services/ai/modelCatalog";
import {
  DEFAULT_MODEL_ID,
  defaultSelection,
  planModelFallback,
} from "../services/ai/modelPolicy";
import type { ModelRecord, ProviderId } from "../services/ai/providerContract";
import {
  canShowAuto,
  canShowGpu,
  canShowNeedle,
  canShowOffline,
  type NeedleEvidence,
} from "../services/ai/uiGates";
import type { ProbeContext, ProbeRecord } from "../services/ai/deviceProbe";
import type {
  OfflineDownloadState,
  OfflineModelStatus,
} from "../services/ai/offlineModelManager";
import {
  getAutoCapabilityCopy,
  getGpuCapabilityCopy,
  getNeedleCapabilityCopy,
  getOfflineCapabilityCopy,
  type MeasuredCapabilityFlags,
} from "../services/appCapabilities";
import {
  isNeedleSelectable,
  legacyAssistantModeToPreference,
  loadSeededAiPreferences as loadSeededAiPreferencesCanonical,
  preferenceToAssistantMode,
  updateAiPreferences,
  type AiPreferences,
} from "../services/ai/aiPreferences";
import { isAssistantSelectableOfflineRecord } from "../services/ai/uiModelRoles";
import { getApplicationAi } from "../services/ai/applicationAi";

/**
 * Assistant mode (AI-022): which transports the assistant may use.
 * Persisted per account; Help honors it at send time (offline-only fails
 * closed with no network). Unknown stored values fall back to `auto`.
 *
 * Legacy vocabulary is retained only for migration compatibility. The UI
 * offers three modes, with on-device-only failing closed on unsupported web.
 */
export type AssistantMode = "auto" | "offline-first" | "offline-only" | "cloud-only";
type EffectiveAssistantMode = ReturnType<typeof preferenceToAssistantMode>;

/** Three transport modes; offline-first is a legacy migration value only. */
export const ASSISTANT_MODES: readonly EffectiveAssistantMode[] = ["auto", "offline-only", "cloud-only"];

/** Honest platform requirement; no dormant fourth mode is advertised. */
export const OFFLINE_BETA_COPY =
  "On-device AI requires the Android app and an installed, checksum-verified model. On-device only never sends to cloud; on web it refuses instead. Needle extracts structured text; SmolVLM2 answers approved image questions.";

const ASSISTANT_MODE_COPY: Record<EffectiveAssistantMode, { label: string; detail: string }> = {
  auto: {
    label: "Automatic",
    detail: "Uses a compatible installed on-device model first. Text may fall back to a connected cloud model if local AI is unavailable or fails; cancellation never falls back.",
  },
  "offline-only": {
    label: "On-device only",
    detail: "Never uses the network for answers. Cloud models refuse without sending anything.",
  },
  "cloud-only": {
    label: "Cloud only",
    detail: "Never attempts on-device answers. Offline rows refuse without running anything.",
  },
};

/**
 * LEGACY migration-source only (P1 single-store fix): the account-scoped
 * `aiPreferences.assistantMode` store is now authoritative. This key is
 * read exactly once per account by `loadSeededAiPreferences` (canonical
 * implementation in services/ai/aiPreferences) and must never gain new
 * writers — `saveAssistantMode` below is deprecated and unwired from all
 * production callers. Exported for the migration read + existing tests.
 */
export function assistantModeKey(accountId: string): string {
  return `findback.ai.assistantMode.v1.${accountId}`;
}

function isAssistantMode(value: unknown): value is AssistantMode {
  return (
    value === "auto" ||
    value === "offline-first" ||
    value === "offline-only" ||
    value === "cloud-only"
  );
}

/**
 * LEGACY migration-source read only. Prefer `loadSeededAiPreferences` /
 * `loadEffectiveAssistantMode` (services/ai/aiPreferences): those consult
 * this key at most once per account (first seeded read) and otherwise serve
 * the authoritative store.
 */
export function loadAssistantMode(accountId: string): AssistantMode {
  try {
    const raw = globalThis.localStorage?.getItem(assistantModeKey(accountId)) ?? null;
    if (isAssistantMode(raw)) return raw;
  } catch {
    // Storage unavailable or blocked: fail closed to the default.
  }
  return "auto";
}

/** Legacy-mode classifier retained for migration callers. */
export function isOfflineMode(mode: AssistantMode): boolean {
  return mode === "offline-first" || mode === "offline-only";
}

/**
 * DEPRECATED — migration-source only, no production callers. The legacy
 * key must not gain new values; all mode writes go through
 * `updateAiPreferences(account, { assistantMode })`. Kept exported so
 * existing tests can seed the migration source.
 */
export function saveAssistantMode(accountId: string, mode: AssistantMode): void {
  try {
    globalThis.localStorage?.setItem(assistantModeKey(accountId), mode);
  } catch {
    // Persistence is best effort; the in-memory choice still applies.
  }
}

/**
 * Backward-compatible re-export: the canonical one-time migration now lives
 * in services/ai/aiPreferences (single authoritative store). This wrapper
 * stays so existing importers keep working; new code should import the
 * canonical helper directly.
 */
export function loadSeededAiPreferences(accountId: string): AiPreferences {
  return loadSeededAiPreferencesCanonical(accountId);
}

/**
 * Push the persisted matches-engine choice into the live matching runtime.
 * Returns true when the runtime accepted it. "use" always applies; "needle"
 * requires Android + an installed model, so on web (or before install) this
 * fails closed and the caller must say so honestly. Never throws.
 */
export function applyMatchesEngineToRuntime(choice: AiPreferences["matchesEngine"]): boolean {
  try {
    getApplicationAi().selectMatchingBackend(choice);
    return true;
  } catch {
    return false;
  }
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  cohere: "Cohere",
  generic: "Custom endpoint",
  offline: "On-device",
};

/**
 * Providers whose ENTIRE loaded catalogue is unknown-priced. Unknown price is
 * never consentable, so such a provider cannot chat until pricing is verified —
 * the UI states that plainly instead of a bare "Connected".
 */
export function computeProviderPricingUnknown(
  catalog: readonly ModelRecord[],
): Partial<Record<ProviderId, boolean>> {
  const totals: Record<string, { total: number; unknown: number }> = {};
  for (const record of catalog) {
    const entry = totals[record.provider] ?? { total: 0, unknown: 0 };
    entry.total += 1;
    if (record.priceClass === "unknown") entry.unknown += 1;
    totals[record.provider] = entry;
  }
  const result: Partial<Record<ProviderId, boolean>> = {};
  for (const provider of SUPPORTED_AI_PROVIDERS) {
    const entry = totals[provider];
    result[provider] = entry !== undefined && entry.total > 0 && entry.unknown === entry.total;
  }
  return result;
}

/** Display-only key tail: never persisted, logged, or sent anywhere. */
export function maskKeyTail(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Honest offline status copy, contextual by cause (F05: never an absolute
 * "not available in this build" line).
 * - Web / builds without the native driver: on-device AI requires Android.
 * - Model absent or unverified: install/verify a model.
 * - Native load/generate failure: local AI could not start.
 */
export const OFFLINE_NEEDS_ANDROID = "On-device AI requires the Android app.";
export const OFFLINE_MODEL_MISSING =
  "No on-device model is installed and verified yet. Install and verify a model to use on-device AI.";
export const OFFLINE_RUNTIME_FAILED = "Local AI could not start. Try again.";

/**
 * Deprecated alias: preserved so existing importers (Help send-gate) keep
 * compiling. Maps to the Android-required line; new code should import the
 * specific constant for its cause.
 */
export const OFFLINE_NOT_AVAILABLE = OFFLINE_NEEDS_ANDROID;

export function honestOfflineDetail(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    if (/requires the Android app/i.test(message)) {
      return message;
    }
    if (/not installed and verified|install and verify|no on-device model/i.test(message)) {
      return OFFLINE_MODEL_MISSING;
    }
    if (/could not start|runtime|failed to load|generation failed|busy/i.test(message)) {
      return OFFLINE_RUNTIME_FAILED;
    }
    // Legacy absolute line from before the F05 fix: normalize to the
    // contextual Android-required copy, never repeat it verbatim.
    if (/not available in this build/i.test(message)) {
      return OFFLINE_NEEDS_ANDROID;
    }
  }
  return OFFLINE_NEEDS_ANDROID;
}

export type AiModelsProps = {
  readonly offlineTools?: import("react").ReactNode;
  /** Account the vault slots and mode are scoped to (defaults to the signed-in user). */
  readonly accountId?: string;
  /** Runtime catalogue source; production loads via vault + registry below. */
  readonly listCatalog?: () => Promise<readonly ModelRecord[]>;
  /**
   * WS-E measured-evidence inputs (borrowed shapes, never owned logic).
   * All default to no evidence, so every gated affordance stays hidden
   * until a fresh, correctness-passing measurement is passed in.
   */
  readonly probeRecords?: readonly ProbeRecord[] | null;
  readonly probeContext?: ProbeContext | null;
  readonly offlineStatus?: OfflineModelStatus | null;
  readonly needleEvidence?: NeedleEvidence | null;
  /**
   * Managed-download controls for the on-device model section. Absent on
   * builds without the native download bridge, where the section stays
   * honestly disabled. Present (even mid-download) once the driver is
   * wired: buttons enable per download state, never for cloud models.
   */
  readonly offlineDownload?: OfflineDownloadControls | null;
};

/**
 * Download/pause/resume/remove affordances for one on-device model.
 * The parent owns the manager + driver and refreshes `state` from
 * `manager.statusOf`; this screen only renders and forwards intent.
 * `notice` carries the last user-facing outcome (gate refusal, checksum
 * mismatch, storage shortfall) — never raw error objects.
 */
export type OfflineDownloadControls = {
  readonly modelId: string;
  readonly state: OfflineDownloadState;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly onDownload: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRemove: () => void;
};

function OfflineDownloadSection({ controls }: { controls: OfflineDownloadControls }) {
  const { state, downloadedBytes, totalBytes, busy, notice } = controls;
  const canDownload =
    !busy && (state === "not-installed" || state === "failed" || state === "paused");
  const canPause = !busy && state === "downloading";
  const canResume = !busy && state === "paused";
  const canRemove =
    !busy && (state === "installed" || state === "paused" || state === "failed");
  const showProgress =
    state === "downloading" || state === "paused" || state === "verifying";
  const progressRatio =
    totalBytes !== null && totalBytes > 0
      ? Math.min(1, Math.max(0, downloadedBytes / totalBytes))
      : null;
  return (
    <div className="flex flex-col gap-2">
      {showProgress ? (
        <div
          role="progressbar"
          aria-label="On-device model download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressRatio === null ? undefined : Math.round(progressRatio * 100)}
          data-testid="ai-offline-progress"
          className="text-sm text-on-surface-variant"
        >
          {progressRatio === null
            ? `Downloaded ${downloadedBytes} bytes.`
            : `Downloaded ${Math.round(progressRatio * 100)}%.`}
        </div>
      ) : null}
      {notice !== null ? (
        <p data-testid="ai-offline-notice" role="status" className="text-sm text-on-surface-variant">
          {notice}
        </p>
      ) : null}
      <div className="flex gap-2">
        {state === "downloading" ? (
          <Button type="button" variant="outline" disabled={!canPause} onClick={controls.onPause}>
            Pause download
          </Button>
        ) : null}
        {state === "paused" && canResume ? (
          <Button type="button" variant="outline" onClick={controls.onResume}>
            Resume download
          </Button>
        ) : null}
        {canDownload ? (
          <Button type="button" variant="outline" onClick={controls.onDownload}>
            {state === "not-installed" ? "Download on-device model" : "Retry download"}
          </Button>
        ) : null}
        {state === "verifying" ? (
          <Button type="button" variant="outline" disabled title="Verifying checksum.">
            Verifying…
          </Button>
        ) : null}
        {canRemove ? (
          <Button type="button" variant="outline" onClick={controls.onRemove}>
            Remove on-device model
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type SlotState = {
  connected: boolean;
  saved: boolean;
  masked: string | null;
};

type ProbeState = {
  phase: "idle" | "testing" | "ready" | "error";
  notice: string | null;
};

const IDLE_PROBE: ProbeState = { phase: "idle", notice: null };

export function AiModels({
  accountId,
  listCatalog,
  probeRecords = null,
  probeContext = null,
  offlineStatus = null,
  needleEvidence = null,
  offlineDownload = null,
  offlineTools = null,
}: AiModelsProps) {
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";
  const [, refreshExperimental] = useState(0);
  const experimental = experimentalProvidersEnabled(account);
  const enabledProviders = SUPPORTED_AI_PROVIDERS.filter((provider) => isProviderEnabled(account, provider));

  const [mode, setMode] = useState<EffectiveAssistantMode>(() =>
    preferenceToAssistantMode(loadSeededAiPreferences(account).assistantMode),
  );
  // Lane A: single account-scoped preference source of truth, owned by Settings.
  const [prefs, setPrefs] = useState<AiPreferences>(() => loadSeededAiPreferences(account));
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [catalog, setCatalog] = useState<readonly ModelRecord[]>([]);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [offlineDetail, setOfflineDetail] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [removing, setRemoving] = useState<ProviderId | null>(null);
  // Generic custom endpoint (account-scoped URL only, never key material).
  const [genericEndpoint, setGenericEndpoint] = useState<string | null>(null);
  const [genericDraft, setGenericDraft] = useState("");
  const [genericNotice, setGenericNotice] = useState<string | null>(null);
  const [genericBusy, setGenericBusy] = useState(false);

  // Account switch: mode, preferences, and slots never cross accounts.
  // The freshly loaded account's preferences are read from the per-account
  // store on every account change, so a previous account's choice never
  // leaks into this one. Photo consumers read the same store via
  // effectivePhotoEngine(account) — no global slot is published.
  useEffect(() => {
    const seeded = loadSeededAiPreferences(account);
    // Authoritative store drives the radio; the legacy key is migration
    // source only and is never written back here.
    setMode(preferenceToAssistantMode(seeded.assistantMode));
    setPrefs(seeded);
    applyMatchesEngineToRuntime(seeded.matchesEngine);
    setProbes({});
    setGenericEndpoint(loadGenericEndpoint(account));
    setGenericDraft("");
    setGenericNotice(null);
  }, [account]);

  useEffect(() => {
    let alive = true;
    setSlotsLoading(true);
    const read = async () => {
      const next: Record<string, SlotState> = {};
      for (const provider of SUPPORTED_AI_PROVIDERS.filter((provider) => isProviderEnabled(account, provider))) {
        try {
          const handle = aiCredentials.credentialHandle(account, provider);
          const [key, saved] = await Promise.all([
            aiCredentials.get(handle.accountId, handle.provider),
            aiCredentials.hasCredential(handle),
          ]);
          next[provider] = {
            connected: key !== null,
            saved,
            masked: maskKeyTail(key),
          };
        } catch {
          next[provider] = { connected: false, saved: false, masked: null };
        }
      }
      if (alive) {
        setSlots(next);
        setSlotsLoading(false);
      }
    };
    void read();
    return () => {
      alive = false;
    };
  }, [account, experimental]);

  // Platform availability comes from the actual registry seam; normalize web
  // refusal so internal errors never leak into user-facing status.
  useEffect(() => {
    let detail: string | null = null;
    try {
      createProviderAdapter("offline", { accountId: account, resolveKey: async () => null });
      detail = null;
    } catch (e) {
      detail = honestOfflineDetail(e);
    }
    setOfflineDetail(detail);
  }, [account]);

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    setCatalogError(null);
    const load = async () => {
      try {
        if (listCatalog !== undefined) {
          const records = await listCatalog();
          if (alive) {
            setCatalog(records.filter((record) => isProviderEnabled(account, record.provider)));
            setRetrievedAt(records[0]?.retrievedAt ?? new Date().toISOString());
          }
          return;
        }
        const cloudRecords = await loadAuthorizedCatalog({
          accountId: account,
          providers: SUPPORTED_AI_PROVIDERS.filter((provider) => isProviderEnabled(account, provider)),
          hasCredential: async (provider: ProviderId) => {
            try {
              return await aiCredentials.hasCredential(
                aiCredentials.credentialHandle(account, provider),
              );
            } catch {
              return false;
            }
          },
          listModels: async (provider: ProviderId, signal?: AbortSignal) => {
            const adapter = createProviderAdapter(provider, {
              accountId: account,
              resolveKey: (id, slot) => aiCredentials.get(id, slot),
              genericBaseURL: loadGenericEndpoint(account) ?? undefined,
              resolveGenericEndpoint: (id) => loadGenericEndpoint(id),
            });
            const list = adapter.listModels;
            if (list === undefined) return [];
            return list(signal);
          },
          retrievedAt: new Date().toISOString(),
        });
        let offlineRecords: readonly ModelRecord[] = [];
        try { offlineRecords = await createProviderAdapter("offline", { accountId: account, resolveKey: async () => null }).listModels?.() ?? []; } catch { /* Web has no native runtime. */ }
        const records = [...offlineRecords, ...cloudRecords];
        if (!alive) return;
        setCatalog(records);
        setRetrievedAt(new Date().toISOString());
      } catch (e) {
        if (alive) {
          setCatalogError(
            e instanceof Error ? e.message : "Could not load the model catalogue.",
          );
        }
      } finally {
        if (alive) setCatalogLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [account, listCatalog, offlineStatus?.checksumVerified, experimental]);

  function chooseMode(next: EffectiveAssistantMode) {
    // Single authoritative write: prefs own the mode. No legacy mirrored
    // write — the legacy key is migration-source only (P1 single-store fix).
    const saved = updateAiPreferences(account, {
      assistantMode: legacyAssistantModeToPreference(next),
    });
    setPrefs(saved);
    setMode(preferenceToAssistantMode(saved.assistantMode));
    announce(`Assistant mode ${ASSISTANT_MODE_COPY[next].label}.`);
  }

  /** Lane A: persist one preference patch for exactly this account. */
  function choosePrefs(patch: Partial<AiPreferences>, notice: string) {
    const next = updateAiPreferences(account, patch);
    setPrefs(next);
    if (patch.matchesEngine !== undefined && !applyMatchesEngineToRuntime(next.matchesEngine)) {
      announce("Matches engine saved. The on-device Needle runtime is unavailable here, so matching stays on USE until the model is installed and verified.");
      return;
    }
    announce(notice);
  }

  async function refreshSlots() {
    const next: Record<string, SlotState> = {};
    for (const provider of enabledProviders) {
      try {
        const handle = aiCredentials.credentialHandle(account, provider);
        const [key, saved] = await Promise.all([
          aiCredentials.get(handle.accountId, handle.provider),
          aiCredentials.hasCredential(handle),
        ]);
        next[provider] = {
          connected: key !== null,
          saved,
          masked: maskKeyTail(key),
        };
      } catch {
        next[provider] = { connected: false, saved: false, masked: null };
      }
    }
    setSlots(next);
  }

  async function removeProvider(provider: ProviderId) {
    if (removing !== null) return;
    setRemoving(provider);
    try {
      await aiCredentials.remove(account, provider);
      await refreshSlots();
      announce(`${PROVIDER_LABELS[provider]} key removed.`);
    } catch {
      setProbes((prev) => ({
        ...prev,
        [provider]: { phase: "error", notice: "Could not remove the saved key. Try again." },
      }));
    } finally {
      setRemoving(null);
    }
  }

  function saveGeneric() {
    if (genericBusy) return;
    setGenericBusy(true);
    setGenericNotice(null);
    try {
      const saved = saveGenericEndpoint(account, genericDraft);
      setGenericEndpoint(saved);
      setGenericDraft("");
      setGenericNotice(
        saved.startsWith("http://")
          ? `Endpoint saved: ${saved}. ${GENERIC_HTTP_LOOPBACK_COPY}`
          : `Endpoint saved: ${saved}.`,
      );
      announce("Custom endpoint saved.");
    } catch (e) {
      setGenericNotice(e instanceof Error ? e.message : "Could not save the endpoint.");
    } finally {
      setGenericBusy(false);
    }
  }

  function removeGeneric() {
    if (genericBusy) return;
    setGenericBusy(true);
    setGenericNotice(null);
    try {
      removeGenericEndpoint(account);
      setGenericEndpoint(null);
      setGenericDraft("");
      setGenericNotice("Endpoint removed. The generic key cannot be used until an endpoint is set again.");
      announce("Custom endpoint removed.");
    } finally {
      setGenericBusy(false);
    }
  }

  async function testProvider(provider: ProviderId) {
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
            notice: `${PROVIDER_LABELS[provider]} has no list endpoint on this build; sends still use your saved key.`,
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
              ? `${PROVIDER_LABELS[provider]} answered, but listed no models for this key.`
              : `${PROVIDER_LABELS[provider]} answered and listed ${rows.length} ${rows.length === 1 ? "model" : "models"} for this key.`,
        },
      }));
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e instanceof Error && e.message.trim() !== "" ? e.message : "The test failed. Try again.";
      setProbes((prev) => ({
        ...prev,
        [provider]: { phase: "error", notice: message.slice(0, 300) },
      }));
    } finally {
      if (!controller.signal.aborted) setBusyProvider(null);
    }
  }

  const fallbackPreview = useMemo(() => {
    if (catalog.length === 0) return null;
    try {
      const present = new Set<ProviderId>();
      for (const provider of SUPPORTED_AI_PROVIDERS) {
        if (slots[provider]?.connected === true) present.add(provider);
      }
      const plan = planModelFallback({
        accountId: account,
        catalog,
        task: "general",
        currentModelId: DEFAULT_MODEL_ID,
        approvedImageIds: [],
        mode: "free-only",
        fingerprintOf: priceFingerprint,
        hasCredential: (provider) => present.has(provider),
      });
      if (plan.ok) {
        return `If the default route fails, the next route tried is ${plan.record.id} (${PROVIDER_LABELS[plan.record.provider]}).`;
      }
      if (plan.reason === "current-unknown") {
        return "The default route is not in the loaded catalogue, so there is no fallback to plan from.";
      }
      return "No compatible fallback route is loaded right now: a failed send keeps your draft.";
    } catch {
      return null;
    }
  }, [catalog, slots, account]);

  const defaults = useMemo(() => defaultSelection(account), [account]);

  const providerPricingUnknown = useMemo(
    () => computeProviderPricingUnknown(catalog),
    [catalog],
  );

  // Lane A: free-only rows selectable as the persisted Assistant default.
  // Paid rows are never offered here — they need explicit per-model consent
  // on the Cloud connections screen (Settings → AI & intelligence → Cloud
  // connections), which persists the choice on confirm.
  // Background on-device engines (Needle tools/embeddings) are excluded:
  // the Assistant default must be conversational.
  const visibleCatalog = catalog.filter((record) => isProviderEnabled(account, record.provider));
  const assistantFreeRows = visibleCatalog.filter(
    (record) => record.priceClass === "free" && isAssistantSelectableOfflineRecord(record),
  );
  const needleReady = isNeedleSelectable(needleEvidence);

  // WS-E: visibility gates consume measured evidence only (no guessing).
  // Defaults (null evidence) keep every affordance hidden.
  const showAuto = canShowAuto(probeRecords, probeContext);
  const showOfflineGate = canShowOffline(offlineStatus);
  const showNeedle = canShowNeedle(needleEvidence);
  const showGpu = canShowGpu(probeRecords, probeContext);
  const measuredFlags: MeasuredCapabilityFlags = {
    hasFreshAutoProbe: showAuto,
    hasVerifiedOfflineModel: showOfflineGate,
    hasNeedleEvidence: showNeedle,
    hasFreshGpuProbe: showGpu,
  };
  const autoCopy = getAutoCapabilityCopy(measuredFlags).join(" ");
  const offlineGateCopy = getOfflineCapabilityCopy(measuredFlags).join(" ");
  const needleCopy = getNeedleCapabilityCopy(measuredFlags).join(" ");
  const gpuCopy = getGpuCapabilityCopy(measuredFlags).join(" ");

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-5">
      <div className="fb-settings-sticky">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <h1 className="text-xl font-semibold">AI &amp; Models</h1>
      </div>
      <p className="text-sm text-on-surface-variant">
        How FindBack answers. Your photo stays on this device unless you choose cloud.
      </p>

      <section aria-label="Assistant mode" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Assistant mode</h2>
        <div role="radiogroup" aria-label="Assistant mode" className="fb-ai-mode-list">
           {ASSISTANT_MODES.map((option) => {
            const checked = mode === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => chooseMode(option)}
                className="fb-ai-mode-option text-left"
              >
                <span className="text-sm font-medium">
                  {checked ? "● " : "○ "}
                  {ASSISTANT_MODE_COPY[option].label}
                </span>
                <span className="text-xs text-on-surface-variant">
                  {ASSISTANT_MODE_COPY[option].detail}
                </span>
              </button>
            );
          })}
        </div>
        <p
          role="note"
          data-testid="ai-offline-mode-note"
          className="text-xs text-on-surface-variant"
        >
          {OFFLINE_BETA_COPY}
        </p>
        {isOfflineMode(mode) ? (
          <p
            role="status"
            data-testid="ai-offline-mode-active"
            className="text-xs text-error"
          >
             {offlineDownload === null
                ? `${ASSISTANT_MODE_COPY[mode].label} is set on this account, but on-device AI is not available here; cloud sends remain blocked.`
                : `${ASSISTANT_MODE_COPY[mode].label} is set. Help automatically picks a compatible installed on-device model; cloud sends remain blocked.`}
          </p>
        ) : null}
      </section>

      <section aria-label="Assistant defaults" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Assistant defaults</h2>
        <p className="text-sm text-on-surface-variant">
          These apply to this account only and never cross accounts. Help starts
          each chat from the Assistant default below; picking a different model
          there is a session-only override.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-pref-model" className="text-sm font-medium">
            Assistant default model
          </label>
          <select
            id="ai-pref-model"
            value={prefs.preferredAssistantModel ?? "automatic"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "automatic") {
                choosePrefs({ preferredAssistantModel: null }, "Assistant default model: Automatic.");
                return;
              }
              choosePrefs({ preferredAssistantModel: value }, `Assistant default model ${value}.`);
            }}
            className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
          >
            <option value="automatic">Automatic ({DEFAULT_MODEL_ID}, free only)</option>
            {assistantFreeRows.map((record) => (
              <option key={record.id} value={record.id}>
                {record.id} (free)
              </option>
            ))}
          </select>
          <p className="text-xs text-on-surface-variant">
            Paid models are picked on the Cloud connections screen (Settings → AI
            &amp; intelligence → Cloud connections); confirming
            explicit consent there updates this account&apos;s default.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-pref-photo" className="text-sm font-medium">
            Photo engine
          </label>
          <select
            id="ai-pref-photo"
            value={prefs.photoEngine}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== "automatic" && value !== "on-device-only" && value !== "cloud-only") {
                return;
              }
              choosePrefs({ photoEngine: value }, `Photo engine ${value}.`);
            }}
            className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
          >
            <option value="automatic">Automatic (on-device first, cloud fallback)</option>
            <option value="on-device-only">On-device only</option>
            <option value="cloud-only">Cloud only</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-pref-matches" className="text-sm font-medium">
            Matches engine
          </label>
          <select
            id="ai-pref-matches"
            value={prefs.matchesEngine}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== "use" && value !== "needle") return;
              choosePrefs({ matchesEngine: value }, `Matches engine ${value}.`);
            }}
            className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
          >
            <option value="use">Use (default)</option>
            <option value="needle" disabled={!needleReady}>
              Needle (needs an installed, verified on-device model)
            </option>
          </select>
          {needleReady ? null : (
            <p className="text-xs text-on-surface-variant">
              Needle unlocks after an on-device model is installed and verified on this device.
            </p>
          )}
        </div>
      </section>

      <section aria-label="On-device AI" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">On-device AI</h2>
        <p data-testid="ai-offline-status" role="status" className="text-sm text-on-surface-variant">
          {offlineDetail ?? "No offline models are ready yet."}
        </p>
        <p className="text-sm text-on-surface-variant">
           Android installs pinned models in app-private storage after an explicit download.
           Needle produces structured item records; SmolVLM2 describes approved images.
           General offline chat quality and device performance are not yet measured.
         </p>
         {offlineTools}
        {offlineDownload === null ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled
               title="On-device downloads require the Android app."
            >
              Download on-device model
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled
               title="On-device management requires the Android app."
            >
              Remove on-device model
            </Button>
          </div>
        ) : (
          <OfflineDownloadSection controls={offlineDownload} />
        )}
      </section>

      <section aria-label="On-device measurements" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">On-device measurements</h2>
        <p className="text-xs text-on-surface-variant">
          Automatic, offline, Needle, and GPU details appear only with fresh,
          correctness-passing measurements on this device. Otherwise the safe
          CPU fallback is served.
        </p>
        <div data-testid="ai-gate-auto" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Automatic: </span>{autoCopy}
        </div>
        <div data-testid="ai-gate-offline" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Offline: </span>{offlineGateCopy}
        </div>
        <div data-testid="ai-gate-needle" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">Needle: </span>{needleCopy}
        </div>
        <div data-testid="ai-gate-gpu" className="text-sm text-on-surface-variant">
          <span className="font-medium text-on-surface">GPU: </span>{gpuCopy}
        </div>
      </section>

      <section aria-label="Cloud providers" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Cloud providers</h2>
        <label className="flex min-h-[48px] items-center gap-3 text-sm">
          <input type="checkbox" checked={experimental} aria-describedby="models-experimental-notice" onChange={(event) => {
            setExperimentalProvidersEnabled(account, event.target.checked);
            refreshExperimental((value) => value + 1);
            announce(`Experimental providers ${event.target.checked ? "enabled" : "disabled"}.`);
          }} />
          Experimental providers
        </label>
        <p id="models-experimental-notice" className="text-xs text-on-surface-variant">{EXPERIMENTAL_PROVIDER_NOTICE}</p>
        {slotsLoading ? (
          <p role="status" className="text-sm text-on-surface-variant">
            Reading saved keys…
          </p>
        ) : (
          <ul className="flex flex-col">
             {enabledProviders.map((provider) => {
              const slot = slots[provider] ?? { connected: false, saved: false, masked: null };
              const probe = probes[provider] ?? IDLE_PROBE;
              const generic = provider === "generic";
              const experimental = isExperimentalProvider(provider);
              const genericInsecure = (genericEndpoint ?? "").startsWith("http://");
              const pricingUnknown = slot.connected && providerPricingUnknown[provider] === true;
              const status = slot.connected
                ? `Connected${slot.masked ? ` · key ending ${slot.masked}` : ""}${
                    pricingUnknown ? " — chat unavailable until pricing can be verified." : ""
                  }`
                : slot.saved
                  ? "A saved key is locked. Manage it on the Cloud connections screen (Settings → AI & intelligence → Cloud connections) to unlock."
                  : "Not connected.";
              const genericSuffix =
                generic && genericEndpoint === null
                  ? " No endpoint set — a key alone cannot be used."
                  : "";
              return (
                <li
                  key={provider}
                  data-testid={`ai-provider-${provider}`}
                  className="flex flex-col gap-1 border-t border-outline-variant py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      {PROVIDER_LABELS[provider]}
                      {experimental ? (
                        <span
                          data-testid={`ai-provider-experimental-${provider}`}
                          className="rounded-m3-xs border border-outline-variant px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-on-surface-variant"
                        >
                          Experimental
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-on-surface-variant">{status}{genericSuffix}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      to={`/ai-connection?provider=${provider}`}
                      aria-label={`Manage ${PROVIDER_LABELS[provider]} key`}
                      className="flex min-h-[48px] items-center rounded-m3-sm border border-outline px-3 text-sm font-medium"
                    >
                      Manage
                    </Link>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busyProvider !== null && busyProvider !== provider}
                      onClick={() => void testProvider(provider)}
                    >
                      {busyProvider === provider ? "Testing…" : "Test"}
                    </Button>
                    {slot.connected || slot.saved ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={removing !== null}
                        onClick={() => void removeProvider(provider)}
                      >
                        {removing === provider ? "Removing…" : "Remove"}
                      </Button>
                    ) : null}
                  </div>
                  {generic ? (
                    <div className="flex flex-col gap-2 rounded-m3-sm border border-outline-variant p-3">
                      <h3 className="text-sm font-semibold">Custom endpoint</h3>
                      {genericEndpoint !== null ? (
                        <p className="text-xs text-on-surface-variant">
                          Endpoint: {genericEndpoint}
                          {genericInsecure ? ` ${GENERIC_HTTP_LOOPBACK_COPY}` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-on-surface-variant">
                          No endpoint is set for this account. {GENERIC_ENDPOINT_MISSING_COPY}
                        </p>
                      )}
                      {(slot.connected || slot.saved) && genericEndpoint === null ? (
                        <p role="alert" className="text-sm text-error">
                          This account holds a generic key, but it cannot be used: no endpoint
                          is configured. Set the base URL below; catalogue, test, and sends
                          all need it.
                        </p>
                      ) : null}
                      <p className="text-xs text-on-surface-variant">{GENERIC_HTTP_POLICY_COPY}</p>
                      <div className="flex flex-col gap-1">
                        <label htmlFor="generic-endpoint" className="text-sm font-medium">
                          Endpoint base URL
                        </label>
                        <input
                          id="generic-endpoint"
                          type="url"
                          value={genericDraft}
                          onChange={(event) => setGenericDraft(event.target.value)}
                          placeholder="https://api.example.com/v1"
                          autoComplete="off"
                          spellCheck={false}
                          className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={genericBusy || genericDraft.trim() === ""}
                          onClick={saveGeneric}
                        >
                          {genericBusy ? "Saving…" : genericEndpoint === null ? "Save endpoint" : "Update endpoint"}
                        </Button>
                        {genericEndpoint !== null ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={genericBusy}
                            onClick={removeGeneric}
                          >
                            Remove endpoint
                          </Button>
                        ) : null}
                      </div>
                      {genericNotice !== null ? (
                        <p aria-live="polite" className="text-sm">
                          {genericNotice}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
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
        )}
      </section>

      <section aria-label="Defaults and fallback policy" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Defaults and fallback</h2>
        <p className="text-sm text-on-surface-variant">
          Default route: {defaults.modelId} · mode: free-only. Paid or unknown-price routes
          always need explicit per-model, per-price confirmation — a key alone is not consent.
        </p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-on-surface-variant">
          <li>Free-only sends never move to a paid or variable-price route.</li>
          <li>With attached photos, only same-provider vision-capable routes qualify.</li>
          <li>Blocked routes and providers without a connected key are skipped.</li>
        </ul>
        {fallbackPreview !== null ? (
          <p role="status" className="text-sm">
            {fallbackPreview}
          </p>
        ) : null}
      </section>

      <section aria-label="Model catalogue" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Model catalogue</h2>
        {catalogLoading ? (
          <p role="status" className="text-sm text-on-surface-variant">
            Loading models…
          </p>
        ) : null}
        {catalogError !== null ? (
          <p role="alert" className="text-sm text-error">
            {catalogError}
          </p>
        ) : null}
        {!catalogLoading && catalogError === null && catalog.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No models loaded. Connect a key on the Cloud connections screen
            (Settings → AI &amp; intelligence → Cloud connections) to unlock its catalogue.
          </p>
        ) : null}
        {catalog.length > 0 ? (
          <ModelCatalogSheet models={visibleCatalog} retrievedAt={retrievedAt} offlineDetail={offlineDetail} />
        ) : null}
      </section>
    </main>
  );
}
