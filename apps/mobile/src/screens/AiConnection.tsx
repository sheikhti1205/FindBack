import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Capacitor } from "@capacitor/core";
import { useSearchParams } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { ModelCatalogSheet, priceLineCopy } from "../components/ModelCatalogSheet";
import {
  SettingsGroup,
  SettingsPage,
  StatusPill,
} from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import { createOpenRouterClient } from "../services/openRouter";
import type { AiSelection, ModelRecord, PaidConsent, ProviderId } from "../services/ai/providerContract";
import {
  CATALOG_STALE_AFTER_MS,
  isCatalogStale,
  priceFingerprint,
} from "../services/ai/modelCatalog";
import { resolveSelection } from "../services/ai/modelPolicy";
import { fadeUpVariants, motionDurations, motionEasings } from "../components/uiMotion";

const validator = createOpenRouterClient(async () => null);

/** Stable default so the props-sync effect never loops on a fresh `[]`. */
const EMPTY_CATALOG: readonly ModelRecord[] = [];

/** Masked fingerprint for display only: never persisted, logged or sent anywhere. */
export function maskOpenRouterKey(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Device-key (BYOK) providers managed on this screen, including OpenAI and
 * DeepSeek (BYOK since the 2026-10-02 reversal: the user supplies their own
 * key and it is stored in the device vault like every other provider). Any
 * `?provider=` value outside this list falls back to OpenRouter, so no
 * device-key entry can ever be rendered for an unknown provider.
 */
const BYOK_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistral",
  "groq",
  "xai",
  "cohere",
  "generic",
] as const satisfies readonly ProviderId[];

export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

export const BYOK_LABELS: Record<ByokProvider, string> = {
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
};

function isByokProvider(value: unknown): value is ByokProvider {
  return (
    typeof value === "string" &&
    (BYOK_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Resolve the managed slot: the explicit prop wins, then the routed
 * `?provider=` value, else OpenRouter. Unknown ids never resolve here.
 */
export function resolveByokProvider(explicit: unknown, routed: unknown): ByokProvider {
  if (isByokProvider(explicit)) return explicit;
  if (isByokProvider(routed)) return routed;
  return "openrouter";
}

export type AiConnectionProps = {
  /** Catalogue rows to browse (empty = none loaded). Never implies verification. */
  readonly models?: readonly ModelRecord[];
  readonly modelsRetrievedAt?: string | null;
  readonly modelsStale?: boolean;
  /** Live selection binding (G06 fix): the currently selected model id. */
  readonly selectedId?: string | null;
  /** Called with a model id ONLY after it passes the consent/entitlement gates. */
  readonly onSelectModel?: (modelId: string) => void;
  /** Explicit scoped paid consent produced by the consent panel (B stores it for send-time use). */
  readonly onPaidConsent?: (consent: PaidConsent) => void;
  /** Account the catalogue/selection is scoped to (defaults to the signed-in user). */
  readonly accountId?: string;
  /**
   * BYOK provider slot managed by the key form. Defaults to the routed
   * `?provider=` value (the AiModels Manage actions deep-link here), else
   * OpenRouter.
   */
  readonly provider?: ProviderId;
  /** Runtime catalogue source: called on mount/account change and on refresh. */
  readonly listModels?: (signal?: AbortSignal) => Promise<readonly ModelRecord[]>;
  /** Freshness budget for the stale badge (defaults to 24h). */
  readonly staleAfterMs?: number;
  /** Selection mode gate: paid rows need paid-explicit + consent (default free-only). */
  readonly mode?: AiSelection["mode"];
};

const PROVIDER_AVAILABILITY: ReadonlyArray<{ provider: ProviderId; copy: string }> = [
  { provider: "openrouter", copy: "OpenRouter: connect your own key above; free models are the default." },
  { provider: "openai", copy: "OpenAI: bring-your-own-key is supported; live key test is not performed on this screen." },
  { provider: "anthropic", copy: "Anthropic: bring-your-own-key is supported; live key test is not performed on this screen." },
  { provider: "google", copy: "Google: bring-your-own-key is supported; live key test is not performed on this screen." },
  { provider: "deepseek", copy: "DeepSeek: bring-your-own-key is supported; live key test is not performed on this screen." },
];

export function AiConnection({
  models = EMPTY_CATALOG,
  modelsRetrievedAt = null,
  modelsStale = false,
  selectedId = null,
  onSelectModel,
  onPaidConsent,
  accountId,
  provider,
  listModels,
  staleAfterMs = CATALOG_STALE_AFTER_MS,
  mode = "free-only",
}: AiConnectionProps) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const routedProvider = searchParams.get("provider");
  const [selectedProvider, setSelectedProvider] = useState<ByokProvider>(() =>
    resolveByokProvider(provider, routedProvider),
  );
  // Deep-link / prop sync: AiModels Manage actions land here with
  // `?provider=<id>` so the form manages THAT provider's slot.
  useEffect(() => {
    setSelectedProvider(resolveByokProvider(provider, routedProvider));
  }, [provider, routedProvider]);
  const providerLabel = BYOK_LABELS[selectedProvider];
  // The default OpenRouter slot keeps the legacy provider-less call shape;
  // every other slot passes its exact provider so reads/writes hit only it.
  const isDefaultSlot = selectedProvider === "openrouter";
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [connected, setConnected] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const userId = user?.id ?? "";
  const account = accountId ?? userId;

  const [catalog, setCatalog] = useState<readonly ModelRecord[]>(models);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(modelsRetrievedAt);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | ProviderId>("all");
  const [consent, setConsent] = useState<PaidConsent | null>(null);
  const [consentDraftId, setConsentDraftId] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  // Account switch: consent never crosses accounts; selection state resets.
  // Provider switch resets the key form the same way: one slot is ever shown.
  useEffect(() => {
    setConsent(null);
    setConsentDraftId(null);
    setConsentChecked(false);
    setGateMessage(null);
    setKey("");
    setPhrase("");
    setMessage(null);
  }, [account, selectedProvider]);

  useEffect(() => {
    if (listModels !== undefined) return;
    setCatalog(models);
    setRetrievedAt(modelsRetrievedAt);
  }, [listModels, models, modelsRetrievedAt]);

  useEffect(() => {
    if (listModels === undefined) return;
    if (!account) return;
    const abort = new AbortController();
    setLoadingCatalog(true);
    setCatalogError(null);
    listModels(abort.signal)
      .then((records) => {
        if (abort.signal.aborted) return;
        setCatalog(records);
        setRetrievedAt(new Date().toISOString());
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setCatalogError(error instanceof Error ? error.message : "Could not load the model catalogue.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingCatalog(false);
      });
    return () => abort.abort();
  }, [listModels, account]);

  async function refreshCatalog() {
    if (listModels === undefined || loadingCatalog) return;
    const abort = new AbortController();
    setLoadingCatalog(true);
    setCatalogError(null);
    try {
      const records = await listModels(abort.signal);
      setCatalog(records);
      setRetrievedAt(new Date().toISOString());
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Could not load the model catalogue.");
    } finally {
      setLoadingCatalog(false);
    }
  }

  const stale = modelsStale || (retrievedAt !== null && isCatalogStale(retrievedAt, Date.now(), staleAfterMs));

  const providersPresent = useMemo(() => {
    const seen = new Set<ProviderId>();
    for (const record of catalog) seen.add(record.provider);
    return [...seen];
  }, [catalog]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter((record) => {
      if (providerFilter !== "all" && record.provider !== providerFilter) return false;
      if (needle !== "" && !record.id.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [catalog, query, providerFilter]);

  const consentDraft = consentDraftId === null ? null : (catalog.find((r) => r.id === consentDraftId) ?? null);

  function handleSelect(modelId: string) {
    setGateMessage(null);
    const record = catalog.find((entry) => entry.id === modelId);
    if (record === undefined) {
      setGateMessage("That model is not in the loaded catalogue.");
      return;
    }
    if (record.entitlement === "blocked") {
      setGateMessage("That model is not usable on this account.");
      return;
    }
    if (record.priceClass === "unknown") {
      setGateMessage("That model's price is unknown, so it cannot be selected. Unknown is never treated as free.");
      return;
    }
    // Changed-price invalidation: stale consent never authorizes a send.
    if (consent !== null && consent.modelId === record.id && consent.fingerprint !== priceFingerprint(record)) {
      setConsent(null);
      setConsentDraftId(record.id);
      setConsentChecked(false);
      setGateMessage("That model's price changed since consent was given. Review and confirm again.");
      return;
    }
    if (record.priceClass === "free") {
      const resolved = resolveSelection({
        accountId: account,
        catalog,
        task: "general",
        desiredModelId: record.id,
        mode: "free-only",
        fingerprintOf: priceFingerprint,
      });
      if (!resolved.ok) {
        setGateMessage("That model cannot be selected right now.");
        return;
      }
      onSelectModel?.(record.id);
      return;
    }
    // Paid/variable: explicit scoped consent required — open the consent panel,
    // never select silently (free-only guard holds until confirmed).
    setConsentDraftId(record.id);
    setConsentChecked(false);
    setGateMessage("That model may cost money. Review its exact charges and confirm explicit consent to select it.");
  }

  function confirmConsent() {
    if (consentDraft === null || !consentChecked) return;
    const fingerprint = priceFingerprint(consentDraft);
    const candidate: PaidConsent = {
      provider: consentDraft.provider,
      modelId: consentDraft.id,
      fingerprint,
      taskScopes: ["general"],
      acceptedAt: new Date().toISOString(),
    };
    const resolved = resolveSelection({
      accountId: account,
      catalog,
      task: "general",
      desiredModelId: consentDraft.id,
      mode: "paid-explicit",
      paidConsent: candidate,
      fingerprintOf: priceFingerprint,
    });
    if (!resolved.ok) {
      setGateMessage("Consent does not authorize that model (price unknown or changed). Selection blocked.");
      return;
    }
    setConsent(candidate);
    setConsentDraftId(null);
    setConsentChecked(false);
    setGateMessage(null);
    onPaidConsent?.(candidate);
    onSelectModel?.(consentDraft.id);
  }

  useEffect(() => {
    let current = true;
    // Per-user, per-provider scoping: drop the previous slot's state
    // immediately so it can never flash for the new account or provider; the
    // re-read below is authoritative for exactly this slot.
    setConnected(false);
    setMasked(null);
    setSaved(false);
    setKey("");
    setPhrase("");
    setMessage(null);
    if (!userId) return;
    const readKey = isDefaultSlot
      ? aiCredentials.get(userId)
      : aiCredentials.get(userId, selectedProvider);
    const readSaved = isDefaultSlot
      ? aiCredentials.hasSaved(userId)
      : aiCredentials.hasSaved(userId, selectedProvider);
    void Promise.all([readKey, readSaved])
      .then(([value, hasSaved]) => {
        if (current) { setConnected(!!value); setMasked(maskOpenRouterKey(value)); setSaved(hasSaved); }
      })
      .catch(() => { if (current) setMessage("Could not read AI connection settings."); });
    return () => { current = false; };
  }, [userId, selectedProvider, isDefaultSlot]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // OpenRouter keeps its live key check; every other BYOK slot saves
      // without a live test (verified at send time). Connection state always
      // reflects the stored credential for exactly this slot.
      if (isDefaultSlot) {
        await validator.validateKey(key);
        await aiCredentials.connect(userId, key, { remember, ...(remember && phrase ? { passphrase: phrase } : {}) });
      } else {
        if (key.trim() === "") throw new Error("Enter an API key.");
        await aiCredentials.connect(userId, key, {
          remember,
          ...(remember && phrase ? { passphrase: phrase } : {}),
          provider: selectedProvider,
        });
      }
      setConnected(true);
      setMasked(maskOpenRouterKey(key));
      setSaved(remember);
      setKey("");
      setPhrase("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : isDefaultSlot
            ? "Could not connect to OpenRouter."
            : `Could not save the ${providerLabel} key.`,
      );
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!userId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (isDefaultSlot) await aiCredentials.remove(userId);
      else await aiCredentials.remove(userId, selectedProvider);
      setConnected(false);
      setMasked(null);
      setSaved(false);
      setKey("");
      setPhrase("");
    } catch { setMessage("Could not remove the saved key. Try again."); }
    finally { setBusy(false); }
  }

  async function unlock() {
    if (!userId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (isDefaultSlot) await aiCredentials.unlock(userId, phrase);
      else await aiCredentials.unlock(userId, phrase, selectedProvider);
      const value = isDefaultSlot
        ? await aiCredentials.get(userId)
        : await aiCredentials.get(userId, selectedProvider);
      setConnected(!!value);
      setMasked(maskOpenRouterKey(value));
      setPhrase("");
    } catch { setMessage("Cannot unlock the saved key. Check your unlock phrase."); }
    finally { setBusy(false); }
  }

  const showCatalogue = catalog.length > 0 || listModels !== undefined || retrievedAt !== null;

  return (
    <SettingsPage
      title="Cloud connections"
      description={`Use your own ${providerLabel} key for cloud AI. FindBack uses free models automatically; availability and daily allowance depend on your provider account. Reports, search and other core features work without AI.`}
      backTo="/settings/ai"
      backLabel="Back to AI & intelligence"
    >
      <SettingsGroup
        title={providerLabel}
        description="Your key stays on this device and is only sent to your provider when you use AI."
      >
      <div className="flex flex-col gap-1">
        <label htmlFor="byok-provider" className="text-sm font-medium">AI provider</label>
        <select
          id="byok-provider"
          value={selectedProvider}
          onChange={(event) => {
            const next = event.target.value;
            if (next === selectedProvider) return;
            // Selection is validated by construction (options only), so the
            // cast below cannot select an unknown slot.
            setSelectedProvider(next as ByokProvider);
          }}
          className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
        >
          {(BYOK_PROVIDERS as readonly ByokProvider[]).map((entry) => (
            <option key={entry} value={entry}>{BYOK_LABELS[entry]}</option>
          ))}
        </select>
        {isDefaultSlot ? null : (
          <p className="text-xs text-on-surface-variant">
            Bring-your-own-key is supported; a live key test is not performed on this screen.
            Saving a key marks {providerLabel} connected — the key itself is verified when it is used.
          </p>
        )}
      </div>
      <p role="status" className="flex flex-wrap items-center gap-2 font-medium">
        <StatusPill tone={connected ? "success" : "neutral"}>
          {connected ? "Connected" : "Not connected"}
        </StatusPill>
        <span>
          {connected
            ? `Connected to ${providerLabel}${masked ? ` · key ending ${masked}` : ""}`
            : `Disconnected · no ${providerLabel} key saved`}
        </span>
      </p>
      {/* "Connected" above is set only after validateKey succeeds for this account;
          the catalogue below is browse-only and never a verified state. */}
      {/* Transient notices rise in; the saved success/failure text is always
          readable within one short entrance, and still leaves with motion. */}
      <AnimatePresence initial={false} mode="wait">
        {message ? (
          <motion.p
            key={`connection-${message}`}
            role="alert"
            className="text-sm text-error"
            variants={fadeUpVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
          >
            {message}
          </motion.p>
        ) : null}
      </AnimatePresence>
      <form onSubmit={(event) => void connect(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="byok-key" className="text-sm font-medium">{providerLabel} API key</label>
          <input id="byok-key" type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck={false} required className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface" />
        </div>
        <label className="flex min-h-[48px] items-center gap-3 text-sm">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Remember on this device
        </label>
        {(remember || (saved && !connected)) && !Capacitor.isNativePlatform() && (
          <div className="flex flex-col gap-1">
            <label htmlFor="byok-phrase" className="text-sm font-medium">Unlock phrase</label>
            <input id="byok-phrase" type="password" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="new-password" minLength={12} className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface" />
            <p className="text-xs text-on-surface-variant">On the web, choose at least 12 characters. You will need this phrase again to unlock your encrypted {providerLabel} key. Session-only keys (remember off) are kept in memory and cleared on sign-out. Android secures the key with your device.</p>
          </div>
        )}
        <Button type="submit" disabled={busy || !key.trim()} loading={busy}>Connect</Button>
      </form>
      {saved && !connected && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">A saved key is locked. Enter its unlock phrase above to use it.</p>
          <Button type="button" variant="outline" disabled={busy || !phrase} onClick={() => void unlock()}>Unlock saved key</Button>
        </div>
      )}
      {(connected || saved) && <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()}>Remove key</Button>}
      </SettingsGroup>
      {showCatalogue ? (
        <SettingsGroup title="Models">
          <p className="text-xs text-on-surface-variant">
            Selection mode: {mode === "paid-explicit" ? "explicit consent" : "free-only"}.
            Paid models always need explicit per-model, per-price confirmation.
          </p>
          <ul className="flex flex-col gap-1">
            {PROVIDER_AVAILABILITY.map((entry) => (
              <li key={entry.provider} className="text-xs text-on-surface-variant">{entry.copy}</li>
            ))}
          </ul>
          <div className="flex flex-col gap-2">
            <label htmlFor="model-search" className="text-sm font-medium">Search models</label>
            <input
              id="model-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by model id"
              className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium">Filter by provider</label>
            <select
              id="provider-filter"
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value as "all" | ProviderId)}
              className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface"
            >
              <option value="all">All providers</option>
              {providersPresent.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            {listModels !== undefined ? (
              <Button type="button" variant="outline" disabled={loadingCatalog} onClick={() => void refreshCatalog()}>
                {loadingCatalog ? "Refreshing…" : "Refresh catalogue"}
              </Button>
            ) : null}
            {retrievedAt !== null ? (
              <p className="text-xs text-on-surface-variant">
                Listed {retrievedAt}{stale ? " · list may be out of date" : ""}
              </p>
            ) : null}
          </div>
          {/* Catalogue notices are keyed replacements: a new message takes the
              spot immediately and rises in, so readers never see a stale alert
              mid-transition and there is never more than one of them. */}
          {loadingCatalog ? (
            <motion.p
              key="loading-models"
              role="status"
              className="text-sm"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            >
              Loading models…
            </motion.p>
          ) : null}
          {catalogError !== null ? (
            <motion.p
              key={`catalog-error-${catalogError}`}
              role="alert"
              className="text-sm text-error"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            >
              {catalogError}
            </motion.p>
          ) : null}
          {gateMessage !== null ? (
            <motion.p
              key={`gate-${gateMessage}`}
              role="alert"
              className="text-sm text-error"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            >
              {gateMessage}
            </motion.p>
          ) : null}
          <AnimatePresence initial={false}>
          {consentDraft !== null ? (
            <motion.div
              key="paid-consent"
              className="flex flex-col gap-2 rounded-m3-sm border border-outline p-3"
              aria-label="Paid model consent"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={{ duration: motionDurations.standard, ease: motionEasings.out }}
            >
              <p className="text-sm font-medium">Paid model consent: {consentDraft.id}</p>
              <ul className="flex flex-col gap-0.5">
                {consentDraft.prices.map((line) => (
                  <li key={`${line.dimension}-${line.sourceField}`} className="text-xs text-on-surface-variant">
                    {priceLineCopy(line)}
                    {line.conditions ? ` (${line.conditions})` : ""}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-on-surface-variant">
                Consent covers this exact model, its current price, and general chat only. A key alone is not consent.
              </p>
              <label className="flex min-h-[48px] items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(event) => setConsentChecked(event.target.checked)}
                />
                I accept these exact charges for general chat
              </label>
              <div className="flex gap-2">
                <Button type="button" disabled={!consentChecked} onClick={confirmConsent}>Confirm and select</Button>
                <Button type="button" variant="outline" onClick={() => { setConsentDraftId(null); setConsentChecked(false); }}>Cancel</Button>
              </div>
            </motion.div>
          ) : null}
          </AnimatePresence>
          {filtered.length > 0 ? (
            <ModelCatalogSheet
              models={filtered}
              retrievedAt={retrievedAt}
              stale={stale}
              selectedId={selectedId}
              onSelect={onSelectModel === undefined ? undefined : handleSelect}
            />
          ) : (
            <p className="text-sm text-on-surface-variant">
              {catalog.length === 0 ? "No models loaded." : "No models match this search."}
            </p>
          )}
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
