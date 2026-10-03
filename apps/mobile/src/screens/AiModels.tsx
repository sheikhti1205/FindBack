import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { ModelCatalogSheet } from "../components/ModelCatalogSheet";
import { announce } from "../components/LiveRegion";
import { aiCredentials, SUPPORTED_AI_PROVIDERS } from "../services/aiCredentials";
import { createProviderAdapter } from "../services/ai/providerRegistry";
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
import type { OfflineModelStatus } from "../services/ai/offlineModelManager";
import {
  getAutoCapabilityCopy,
  getGpuCapabilityCopy,
  getNeedleCapabilityCopy,
  getOfflineCapabilityCopy,
  type MeasuredCapabilityFlags,
} from "../services/appCapabilities";

/**
 * Assistant mode (AI-022): which transports the assistant may use.
 * Persisted per account; Help honors it at send time (offline-only fails
 * closed with no network). Unknown stored values fall back to `auto`.
 *
 * Beta scope: on-device transport is not wired until the native bridge lands,
 * so `offline-first`/`offline-only` are accepted and honored defensively but
 * are NOT offered as selectable modes — the picker exposes only the modes that
 * this build can actually honor. A previously stored offline mode is preserved
 * (never silently relaxed to a mode that sends to the network) and surfaced as
 * unavailable until the user switches to Auto or Cloud-only.
 */
export type AssistantMode = "auto" | "offline-first" | "offline-only" | "cloud-only";

/** Selectable modes in this build. Offline modes are informational only (see OFFLINE_BETA_COPY). */
export const ASSISTANT_MODES: readonly AssistantMode[] = ["auto", "cloud-only"];

/** Informational (non-actionable) stand-in for the offline modes this build cannot honor. */
export const OFFLINE_BETA_COPY =
  "On-device AI (Offline-first and Offline-only) is not available in this build yet — it arrives with the native bridge in a later beta. Until then, Auto and Cloud-only are the usable modes.";

const ASSISTANT_MODE_COPY: Record<AssistantMode, { label: string; detail: string }> = {
  auto: {
    label: "Auto",
    detail: "The picked model decides. No transport is forced or refused.",
  },
  "offline-first": {
    label: "Offline-first",
    detail: "On-device answers are preferred wherever one is ready.",
  },
  "offline-only": {
    label: "Offline-only",
    detail: "Never uses the network for answers. Cloud models refuse without sending anything.",
  },
  "cloud-only": {
    label: "Cloud-only",
    detail: "Never attempts on-device answers. Offline rows refuse without running anything.",
  },
};

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

export function loadAssistantMode(accountId: string): AssistantMode {
  try {
    const raw = globalThis.localStorage?.getItem(assistantModeKey(accountId)) ?? null;
    if (isAssistantMode(raw)) return raw;
  } catch {
    // Storage unavailable or blocked: fail closed to the default.
  }
  return "auto";
}

/** True for the on-device modes this build cannot honor yet. */
export function isOfflineMode(mode: AssistantMode): boolean {
  return mode === "offline-first" || mode === "offline-only";
}

export function saveAssistantMode(accountId: string, mode: AssistantMode): void {
  try {
    globalThis.localStorage?.setItem(assistantModeKey(accountId), mode);
  } catch {
    // Persistence is best effort; the in-memory choice still applies.
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
 * Providers whose end-to-end send path has been live-verified for this beta.
 * Everything else is surfaced with an "Experimental" marker so testers know the
 * adapter is wired and vault-backed but a real-key send is not yet proven.
 */
export const LIVE_TESTED_PROVIDERS: readonly ProviderId[] = ["openrouter"];

export function isExperimentalProvider(provider: ProviderId): boolean {
  return !LIVE_TESTED_PROVIDERS.includes(provider);
}

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
 * Honest offline status copy. The offline adapter is deliberately unwired
 * from the registry and vault until the native bridge lands, so the seam
 * refuses; only a not-available refusal is surfaced verbatim, everything
 * else normalizes to the fixed not-available line (never an internal
 * unknown-provider message).
 */
export const OFFLINE_NOT_AVAILABLE = "Offline AI is not available in this build.";

export function honestOfflineDetail(error: unknown): string {
  if (error instanceof Error && /not available in this build/i.test(error.message)) {
    return error.message;
  }
  return OFFLINE_NOT_AVAILABLE;
}

export type AiModelsProps = {
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
};

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
}: AiModelsProps) {
  const { user } = useAuth();
  const account = accountId ?? user?.id ?? "local";

  const [mode, setMode] = useState<AssistantMode>(() => loadAssistantMode(account));
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

  // Account switch: mode and slots never cross accounts.
  useEffect(() => {
    setMode(loadAssistantMode(account));
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
      for (const provider of SUPPORTED_AI_PROVIDERS) {
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
  }, [account]);

  // Offline honesty comes from the registry seam itself: the adapter stays
  // unwired until the native bridge lands, so the seam refuses and the
  // status stays not-available. The refusal wording is normalized here so a
  // registry unknown-provider message never leaks as the user-facing status.
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
            setCatalog(records);
            setRetrievedAt(records[0]?.retrievedAt ?? new Date().toISOString());
          }
          return;
        }
        const records = await loadAuthorizedCatalog({
          accountId: account,
          providers: SUPPORTED_AI_PROVIDERS,
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
  }, [account, listCatalog]);

  function chooseMode(next: AssistantMode) {
    setMode(next);
    saveAssistantMode(account, next);
    announce(`Assistant mode ${ASSISTANT_MODE_COPY[next].label}.`);
  }

  async function refreshSlots() {
    const next: Record<string, SlotState> = {};
    for (const provider of SUPPORTED_AI_PROVIDERS) {
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
      <BackButton fallbackTo="/profile" label="Back to profile" />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">AI &amp; Models</h1>
        <p className="text-sm text-on-surface-variant">
          Modes, on-device status, cloud keys, defaults, and the price-visible catalogue.
        </p>
      </header>

      <section aria-label="Assistant mode" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Assistant mode</h2>
        <div role="radiogroup" aria-label="Assistant mode" className="flex flex-col gap-2">
          {ASSISTANT_MODES.map((option) => {
            const checked = mode === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => chooseMode(option)}
                className="flex min-h-[48px] flex-col justify-center gap-0.5 rounded-m3-sm border border-outline-variant px-3 text-left hover:bg-surface-container"
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
            {ASSISTANT_MODE_COPY[mode].label} is set on this account, but on-device AI is not
            available in this build, so nothing is sent. Choose Auto or Cloud-only above to use
            cloud AI.
          </p>
        ) : null}
      </section>

      <section aria-label="On-device AI" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">On-device AI</h2>
        <p data-testid="ai-offline-status" role="status" className="text-sm text-on-surface-variant">
          {offlineDetail ?? "No offline models are ready yet."}
        </p>
        <p className="text-sm text-on-surface-variant">
          No on-device models are installed. Storage use is unknown until the native bridge
          lands — nothing here downloads, verifies, or runs.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled
            title="On-device downloads arrive with the native bridge."
          >
            Download on-device model
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled
            title="On-device management arrives with the native bridge."
          >
            Remove on-device model
          </Button>
        </div>
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
        {slotsLoading ? (
          <p role="status" className="text-sm text-on-surface-variant">
            Reading saved keys…
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {SUPPORTED_AI_PROVIDERS.map((provider) => {
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
                  ? "A saved key is locked. Manage it on the AI Connection screen to unlock."
                  : "Not connected.";
              const genericSuffix =
                generic && genericEndpoint === null
                  ? " No endpoint set — a key alone cannot be used."
                  : "";
              return (
                <li
                  key={provider}
                  data-testid={`ai-provider-${provider}`}
                  className="flex flex-col gap-2 rounded-m3-sm border border-outline-variant p-3"
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
            No models loaded. Connect a key on the AI Connection screen to unlock its catalogue.
          </p>
        ) : null}
        {catalog.length > 0 ? (
          <ModelCatalogSheet models={catalog} retrievedAt={retrievedAt} offlineDetail={offlineDetail} />
        ) : null}
      </section>
    </main>
  );
}
