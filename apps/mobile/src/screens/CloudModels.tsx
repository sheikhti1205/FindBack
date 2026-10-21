import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { AdvancedDisclosure, SettingsPage } from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";
import type { ModelRecord } from "../services/ai/providerContract";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS, loadCloudModelPreferences, loadUnresolvedLegacyModelId, sameCloudModel, saveCloudModelDefault, toggleCloudFavorite, type CloudModel, type CloudProvider } from "../services/ai/cloudModelPreferences";

export const CLOUD_COST_COPY = "Charges may apply according to your provider account and selected model.";
const fieldClass = "min-h-[44px] min-w-0 w-full rounded-m3-sm border border-outline bg-surface px-3 text-sm text-on-surface";
/**
 * A provider that never answers must not strand this screen on "Loading
 * models…" forever: the list call is raced against this bound, and Refresh
 * stays usable so the reader can ask again.
 */
export const MODEL_LIST_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MARKER = "model-list-timeout";

/**
 * The legacy model id this account still carries, if it cannot be resolved.
 *
 * `catalogueAnswered` says whether the provider's catalogue actually answered:
 * a catalogue that never came back proves nothing about the id, so the copy
 * must not claim the id was rejected.
 */
function resolvePendingLegacy(accountId: string, catalogueAnswered: boolean): { id: string; catalogueAnswered: boolean } | null {
  const id = loadUnresolvedLegacyModelId(accountId);
  return id === null ? null : { id, catalogueAnswered };
}

async function listProviderModels(accountId: string, provider: CloudProvider, signal: AbortSignal): Promise<readonly ModelRecord[]> {
  // Presence check only: the adapter resolves the vault key itself, so no key
  // material ever passes through this screen.
  const present = await aiCredentials.hasCredential(aiCredentials.credentialHandle(accountId, provider));
  if (signal.aborted) return [];
  if (!present) throw new Error("No saved key");
  const adapter = createProviderAdapter(provider, {
    accountId, resolveKey: (id, slot) => aiCredentials.get(id, slot), resolveGenericEndpoint: loadGenericEndpoint,
    // Listing needs no conversation framing. Help owns send-time framing.
    assembleSystemText: () => undefined,
  });
  return await adapter.listModels?.(signal) ?? [];
}

export type CloudModelPickerProps = {
  accountId: string;
  selected?: CloudModel | null;
  /** Called with the chosen model and its consumer title (never a raw id alone). */
  onSelect?: (model: CloudModel, title: string) => void;
  /** Hermetic catalogue seam; never receives credentials. */
  listModels?: (provider: CloudProvider, signal: AbortSignal) => Promise<readonly ModelRecord[]>;
};

/** Shared by Chat's sheet and the Models settings route; one preference owner. */
export function CloudModelPicker(props: CloudModelPickerProps) {
  return <AccountModelPicker key={props.accountId} {...props} />;
}
function AccountModelPicker({ accountId, selected, onSelect, listModels }: CloudModelPickerProps) {
  const [prefs, setPrefs] = useState(() => loadCloudModelPreferences(accountId));
  const [provider, setProvider] = useState<CloudProvider>(selected?.provider ?? prefs.defaultModel?.provider ?? "openrouter");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [records, setRecords] = useState<readonly ModelRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  // A legacy model id that could not be resolved to a provider (the legacy
  // field stores no provider and some providers publish no catalogue): the
  // choice is not dropped silently, the reader is told it is theirs to pick.
  // It is only known once the catalogue has answered, so it starts empty.
  // `catalogueAnswered` keeps the copy honest: a failed load proves nothing
  // about the id, an answered catalogue does.
  const [pendingLegacy, setPendingLegacy] = useState<{ id: string; catalogueAnswered: boolean } | null>(null);
  // The provider select is only auto-moved to a migrated default while the
  // reader has not chosen a provider themselves.
  const providerChosenByUser = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    setRecords([]); setLoading(true); setMessage(null); setError(null);
    const load = listModels ? listModels(provider, abort.signal) : listProviderModels(accountId, provider, abort.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(MODEL_LIST_TIMEOUT_MARKER)), MODEL_LIST_TIMEOUT_MS);
    });
    void Promise.race([load, timeout]).then((rows) => {
      if (abort.signal.aborted) return;
      const cloud = rows.filter((row) => row.provider !== "offline");
      setRecords(cloud.filter((row) => row.provider === provider && row.input.includes("text") && row.output.includes("text")));
      const migrated = loadCloudModelPreferences(accountId, cloud);
      setPrefs(migrated);
      // A legacy default that only resolves against this catalogue must be
      // visible here too: move the provider to it so its rows and the
      // "Default" badge are not hidden on a different provider. The reconcile
      // only reaches a legacy id that this catalogue can resolve — an id
      // belonging to a provider without a catalogue endpoint stays pending
      // and is surfaced below instead of being moved.
      if (!selected && !providerChosenByUser.current) {
        const next = migrated.defaultModel?.provider;
        if (next !== undefined && next !== provider) setProvider(next);
      }
      setPendingLegacy(resolvePendingLegacy(accountId, true));
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      // A failed catalogue leaves any legacy id unresolved: say so, without
      // claiming the catalogue rejected it.
      setPendingLegacy(resolvePendingLegacy(accountId, false));
      setMessage(error instanceof Error && error.message === MODEL_LIST_TIMEOUT_MARKER
        ? "The provider didn’t answer in time. Refresh to try again, or enter a model ID below."
        : "Couldn’t load models. Check your provider key, or enter a model ID below.");
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [accountId, provider, listModels, tick]);

  function choose(model: CloudModel, title: string) {
    setError(null);
    try {
      if (onSelect) onSelect(model, title);
      else {
        setPrefs(saveCloudModelDefault(accountId, model));
        // The account now has a cloud record, so the legacy id is resolved and
        // the pending note must not keep claiming it is unmatched.
        setPendingLegacy(resolvePendingLegacy(accountId, true));
        setMessage("Default model saved.");
      }
    } catch { if (mounted.current) setError("Couldn’t save this model. Check the model ID and device storage, then try again."); }
  }
  const saved = [...prefs.favorites, ...prefs.lastUsed, ...(prefs.defaultModel ? [prefs.defaultModel] : [])];
  const models: { model: CloudModel; title: string }[] = records.map((row) => ({ model: { provider, modelId: row.id }, title: row.displayName?.trim() || row.id }));
  for (const model of saved) if (model.provider === provider && !models.some((row) => sameCloudModel(row.model, model))) models.push({ model, title: model.modelId });
  const needle = query.trim().toLowerCase();
  const filtered = models.filter(({ title, model }) => `${title} ${model.modelId}`.toLowerCase().includes(needle));
  return <div className="flex min-w-0 flex-col gap-3">
    <label className="flex flex-col gap-1 text-sm">Provider<select className={fieldClass} value={provider} onChange={(event) => { providerChosenByUser.current = true; setProvider(event.target.value as CloudProvider); setManual(""); }}>{CLOUD_PROVIDERS.map((id) => <option key={id} value={id}>{CLOUD_PROVIDER_LABELS[id]}</option>)}</select></label>
    <label className="flex flex-col gap-1 text-sm">Search models<input type="search" className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" data-testid="cloudmodels-status" className="min-w-0 text-xs text-on-surface-variant">{loading ? "Loading models…" : message ?? (filtered.length ? "Choose a model for text chat." : "No models listed. You can enter a model ID below.")}</p><Button variant="text" onClick={() => setTick((value) => value + 1)}>Refresh</Button></div>
    {/* A persistent live region: the pending note arrives after an async load
        and must be announced, not silently rendered. */}
    <p aria-live="polite" data-testid="cloudmodels-pending" className="min-w-0 break-words text-xs text-on-surface-variant">{pendingLegacy === null ? "" : pendingLegacy.catalogueAnswered
      ? `Your previous model (${pendingLegacy.id}) couldn’t be matched to a provider. Choose its provider and enter the model ID below.`
      : `Your previous model (${pendingLegacy.id}) is still saved, but the model list didn’t load. Choose its provider and enter the model ID below.`}</p>
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    <ul className="divide-y divide-outline-variant">{filtered.map(({ model, title }) => {
      const favorite = prefs.favorites.some((item) => sameCloudModel(item, model));
      const isDefault = sameCloudModel(prefs.defaultModel, model);
      return <li key={`${provider}:${model.modelId}`} className="flex min-w-0 items-center gap-2 py-2">
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{title}</p><p className="text-xs text-on-surface-variant">{[isDefault ? "Default" : null, prefs.lastUsed.some((item) => sameCloudModel(item, model)) ? "Last used" : null, favorite ? "Favorite" : null].filter(Boolean).join(" · ")}</p></div>
        <button type="button" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full" aria-label={`Favorite ${title}`} aria-pressed={favorite} onClick={() => { try { setPrefs(toggleCloudFavorite(accountId, model)); } catch { setError("Couldn’t save favorites on this device."); } }}><Star size={18} fill={favorite ? "currentColor" : "none"} aria-hidden /></button>
        <button type="button" className="min-h-[44px] shrink-0 rounded-full px-2 text-xs font-medium underline" aria-label={onSelect ? `Use ${title}` : `Set ${title} as default`} aria-pressed={sameCloudModel(selected ?? prefs.defaultModel, model)} onClick={() => choose(model, title)}>{onSelect ? "Use" : isDefault ? "Default" : "Set default"}</button>
      </li>;
    })}</ul>
    <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); const id = manual.trim(); if (id !== "") choose({ provider, modelId: id }, id); }}>
      <label className="flex flex-col gap-1 text-sm">Model ID<input className={fieldClass} value={manual} maxLength={256} onChange={(event) => setManual(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} required /></label>
      <p className="text-xs text-on-surface-variant">Enter the exact model ID from your provider. Availability is checked when you send a message.</p>
      <Button type="submit" variant="outline" disabled={!manual.trim() || /\s/.test(manual.trim())}>Use model</Button>
    </form>
    <p className="text-xs text-on-surface-variant">{CLOUD_COST_COPY}</p>
    <AdvancedDisclosure title="Model details"><ul className="text-xs text-on-surface-variant">{filtered.map(({ model, title }) => <li className="break-all" key={model.modelId}>{title}: {model.modelId}</li>)}</ul></AdvancedDisclosure>
  </div>;
}

/**
 * Settings → AI Chat → Models. Route mounting is the coordinator's job:
 * mount this at `/settings/ai/chat-models` (the link on the Providers
 * screen points there). `listModels` is a hermetic seam for tests; without
 * it the screen lists models through the provider adapter using the
 * account's own saved key.
 */
export function CloudModels({ listModels }: { listModels?: CloudModelPickerProps["listModels"] }) {
  const { user } = useAuth();
  return <SettingsPage title="Models" description="Choose a default for Chat, or keep favorites for next time." backTo="/settings/ai" backLabel="Back to AI Chat"><CloudModelPicker accountId={user?.id ?? "local"} listModels={listModels} /></SettingsPage>;
}
