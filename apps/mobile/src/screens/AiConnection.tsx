import { useEffect, useRef, useState, type FormEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { AdvancedDisclosure, SettingsGroup, SettingsPage } from "../components/settings";
import { aiCredentials } from "../services/aiCredentials";
import { loadGenericEndpoint, saveGenericEndpoint, removeGenericEndpoint, validateGenericEndpoint, GENERIC_HTTP_LOOPBACK_COPY } from "../services/ai/genericEndpoint";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABELS, loadCloudModelPreferences, saveCloudModelDefault, type CloudProvider } from "../services/ai/cloudModelPreferences";
import type { ProviderId } from "../services/ai/providerContract";

export type ByokProvider = CloudProvider;
export const BYOK_LABELS = CLOUD_PROVIDER_LABELS;

/**
 * Masked tail for the saved-state line. The raw key is never stored, logged,
 * or rendered: only the last four characters survive, and only when the key
 * is long enough to have a meaningful tail.
 */
export function maskKeyTail(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}
export function resolveByokProvider(explicit: unknown, routed: unknown): ByokProvider {
  for (const candidate of [explicit, routed]) if (CLOUD_PROVIDERS.includes(candidate as CloudProvider)) return candidate as CloudProvider;
  return "openrouter";
}
export type AiConnectionProps = { provider?: ProviderId };
const fieldClass = "min-h-[44px] min-w-0 w-full rounded-m3-sm border border-outline bg-surface px-3 text-sm text-on-surface";

export function AiConnection({ provider }: AiConnectionProps) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const routed = params.get("provider");
  const [selected, setSelected] = useState(() => resolveByokProvider(provider, routed));
  useEffect(() => { setSelected(resolveByokProvider(provider, routed)); }, [provider, routed]);
  return <SettingsPage title="Providers" description="Use your own key for optional Chat. Your provider receives messages when you send; FindBack’s core features don’t need a key." backTo="/settings/ai" backLabel="Back to AI Chat">
    <label className="flex flex-col gap-1 text-sm">Provider<select className={fieldClass} value={selected} onChange={(event) => setSelected(event.target.value as CloudProvider)}>{CLOUD_PROVIDERS.map((id) => <option key={id} value={id}>{CLOUD_PROVIDER_LABELS[id]}</option>)}</select></label>
    {user ? <ProviderKeyForm key={`${user.id}:${selected}`} accountId={user.id} provider={selected} /> : <p role="status" className="text-sm">Sign in to manage your provider keys.</p>}
    <Link to="/settings/ai/chat-models" className="flex min-h-[48px] items-center text-sm font-medium underline">Choose Chat models</Link>
  </SettingsPage>;
}

function ProviderKeyForm({ accountId, provider }: { accountId: string; provider: CloudProvider }) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [present, setPresent] = useState(false);
  const [saved, setSaved] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState(() => loadGenericEndpoint(accountId) ?? "");
  const [endpointSaved, setEndpointSaved] = useState(() => loadGenericEndpoint(accountId) !== null);
  const [manualModel, setManualModel] = useState(() => loadCloudModelPreferences(accountId).defaultModel?.provider === provider
    ? loadCloudModelPreferences(accountId).defaultModel?.modelId ?? ""
    : "");
  const mounted = useRef(true);
  const operation = useRef(false);
  const label = CLOUD_PROVIDER_LABELS[provider];
  const native = Capacitor.isNativePlatform();
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      aiCredentials.hasCredential(aiCredentials.credentialHandle(accountId, provider)),
      aiCredentials.hasSaved(accountId, provider),
      // The key is read only to derive a masked tail. The raw value is never
      // stored in state, rendered, logged, or sent anywhere.
      aiCredentials.get(accountId, provider),
    ]).then(([hasKey, hasSaved, raw]) => {
      if (!mounted.current) return;
      setPresent(hasKey); setSaved(hasSaved); setMasked(maskKeyTail(raw));
    }).catch(() => { if (mounted.current) setError("Couldn’t read your saved key. Try opening Providers again."); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [accountId, provider]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current || !key.trim()) return;
    operation.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      await aiCredentials.connect(accountId, key.trim(), { provider, remember, ...(remember && phrase ? { passphrase: phrase } : {}) });
      if (!mounted.current) return;
      setPresent(true); setSaved(remember); setMasked(maskKeyTail(key)); setKey(""); setPhrase(""); setMessage("Key saved. It will be checked when you send a message.");
    } catch {
      if (mounted.current) setError("Couldn’t save the key. Check your storage or unlock phrase and try again.");
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      await aiCredentials.remove(accountId, provider);
      if (!mounted.current) return;
      setPresent(false); setSaved(false); setMasked(null); setKey(""); setPhrase(""); setMessage("Key deleted.");
    } catch { if (mounted.current) setError("Couldn’t delete the key. Try again."); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function unlock() {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setMessage(null);
    try {
      await aiCredentials.unlock(accountId, phrase, provider);
      const available = await aiCredentials.hasCredential(aiCredentials.credentialHandle(accountId, provider));
      if (!mounted.current) return;
      setPresent(available); setPhrase(""); setMessage(available ? "Key unlocked." : "The saved key is still locked.");
    } catch { if (mounted.current) setError("Couldn’t unlock the key. Check your unlock phrase."); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  function saveEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setMessage(null);
    const checked = validateGenericEndpoint(endpoint);
    if (!checked.ok) { setError("Enter a valid HTTPS base URL without credentials, query parameters or a fragment. HTTP is allowed only for a loopback address."); return; }
    try { setEndpoint(saveGenericEndpoint(accountId, endpoint)); setEndpointSaved(true); setMessage(checked.insecure ? GENERIC_HTTP_LOOPBACK_COPY : "Base URL saved."); }
    catch { setError("Couldn’t save the base URL on this device. Try again."); }
  }
  function saveManualModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setMessage(null);
    const id = manualModel.trim();
    if (id === "") return;
    try { saveCloudModelDefault(accountId, { provider, modelId: id }); setMessage("Model saved as your default for Chat."); }
    catch { setError("Couldn’t save the model ID. Use the exact ID from your provider, without spaces."); }
  }
  const savedState = loading
    ? "Checking saved key…"
    : present
      ? masked ? `Key saved · ${masked}` : "Key saved"
      : saved ? "Saved key is locked · ••••" : "No key saved";
  return <SettingsGroup title={label} description="Keys stay in this device’s credential storage. Saving does not contact the provider.">
    <p role="status" className="text-sm">{savedState}</p>
    {message && <p role="status" className="text-sm text-on-surface-variant">{message}</p>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">{label} API key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} className={fieldClass} autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy} /></label>
      <label className="flex min-h-[44px] items-center gap-3 text-sm"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />Remember on this device</label>
      {(remember || (saved && !present)) && !native && <label className="flex flex-col gap-1 text-sm">Unlock phrase<input type="password" className={fieldClass} value={phrase} onChange={(event) => setPhrase(event.target.value)} minLength={12} autoComplete="new-password" disabled={busy} /><span className="text-xs text-on-surface-variant">Use at least 12 characters. You’ll need this phrase to unlock the remembered key.</span></label>}
      <p className="text-xs text-on-surface-variant">{native ? "Android protects remembered keys with device storage." : "Without Remember, the key lasts for this session."} Signing out removes session and remembered keys.</p>
      <Button type="submit" disabled={busy || !key.trim() || (!native && remember && phrase.length < 12)} loading={busy}>Save key</Button>
    </form>
    {saved && !present && <Button variant="outline" disabled={busy || (!native && !phrase)} onClick={() => void unlock()}>Unlock saved key</Button>}
    {(present || saved) && <Button variant="outline" disabled={busy} onClick={() => void remove()}>Delete key</Button>}
    {provider === "generic" && <AdvancedDisclosure title="Advanced">
      {/* Two SIBLING forms: a form may not contain another form, and each
          input must submit its own action (base URL vs model ID). */}
      <form className="flex flex-col gap-3" onSubmit={saveEndpoint}>
        <label className="flex flex-col gap-1 text-sm">Base URL<input type="url" className={fieldClass} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /></label>
        <p className="text-xs text-on-surface-variant">Use your provider’s OpenAI-compatible API base URL. HTTPS is required, except for a loopback address. Never include a key in the URL.</p>
        <Button type="submit" variant="outline">Save base URL</Button>
        {endpointSaved && <Button type="button" variant="text" onClick={() => { removeGenericEndpoint(accountId); setEndpoint(""); setEndpointSaved(false); setMessage("Base URL deleted."); }}>Delete base URL</Button>}
      </form>
      <form className="flex flex-col gap-2 border-t border-outline-variant pt-3" onSubmit={saveManualModel}>
        <label className="flex flex-col gap-1 text-sm">Model ID<input className={fieldClass} value={manualModel} maxLength={256} onChange={(event) => setManualModel(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /></label>
        <p className="text-xs text-on-surface-variant">The exact model ID from your provider. Availability is checked when you send a message.</p>
        <Button type="submit" variant="outline" disabled={!manualModel.trim() || /\s/.test(manualModel.trim())}>Save model ID</Button>
      </form>
    </AdvancedDisclosure>}
  </SettingsGroup>;
}
