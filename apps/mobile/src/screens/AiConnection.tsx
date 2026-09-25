import { useEffect, useState, type FormEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { KeyRound } from "lucide-react";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { aiCredentials } from "../services/aiCredentials";
import { createOpenRouterClient } from "../services/openRouter";

const validator = createOpenRouterClient(async () => null);

/** Masked fingerprint for display only: never persisted, logged or sent anywhere. */
export function maskOpenRouterKey(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}

export function AiConnection() {
  const { user } = useAuth();
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [connected, setConnected] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const userId = user?.id ?? "";

  useEffect(() => {
    let current = true;
    // Per-user scoping: drop the previous account's state immediately so it can
    // never flash for the new account; the re-read below is authoritative.
    setConnected(false);
    setMasked(null);
    setSaved(false);
    setKey("");
    setPhrase("");
    setMessage(null);
    if (!userId) return;
    void Promise.all([aiCredentials.get(userId), aiCredentials.hasSaved(userId)])
      .then(([value, hasSaved]) => {
        if (current) { setConnected(!!value); setMasked(maskOpenRouterKey(value)); setSaved(hasSaved); }
      })
      .catch(() => { if (current) setMessage("Could not read AI connection settings."); });
    return () => { current = false; };
  }, [userId]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await validator.validateKey(key);
      await aiCredentials.connect(userId, key, { remember, ...(remember && phrase ? { passphrase: phrase } : {}) });
      setConnected(true);
      setMasked(maskOpenRouterKey(key));
      setSaved(remember);
      setKey("");
      setPhrase("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect to OpenRouter.");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!userId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await aiCredentials.remove(userId);
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
      await aiCredentials.unlock(userId, phrase);
      const value = await aiCredentials.get(userId);
      setConnected(!!value);
      setMasked(maskOpenRouterKey(value));
      setPhrase("");
    } catch { setMessage("Cannot unlock the saved key. Check your unlock phrase."); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-5">
      <BackButton fallbackTo="/profile" label="Back to profile" />
      <header className="flex items-center gap-3">
        <KeyRound size={22} aria-hidden />
        <h1 className="text-xl font-semibold">AI Connection</h1>
      </header>
      <p className="text-sm text-on-surface-variant">
        Connect your own OpenRouter API key. FindBack uses free models automatically; availability and daily allowance depend on your OpenRouter account. Reports, search and other core features work without AI.
      </p>
      <p role="status" className="font-medium">
        {connected ? `Connected${masked ? ` · key ending ${masked}` : ""}` : "Disconnected"}
      </p>
      {message ? <p role="alert" className="text-sm text-error">{message}</p> : null}
      <form onSubmit={(event) => void connect(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="openrouter-key" className="text-sm font-medium">OpenRouter API key</label>
          <input id="openrouter-key" type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck={false} required className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface" />
        </div>
        <label className="flex min-h-[48px] items-center gap-3 text-sm">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Remember on this device
        </label>
        {(remember || (saved && !connected)) && !Capacitor.isNativePlatform() && (
          <div className="flex flex-col gap-1">
            <label htmlFor="openrouter-phrase" className="text-sm font-medium">Unlock phrase</label>
            <input id="openrouter-phrase" type="password" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="new-password" minLength={12} className="min-h-[48px] rounded-m3-sm border border-outline bg-surface px-3 text-on-surface" />
            <p className="text-xs text-on-surface-variant">On the web, choose at least 12 characters. You will need this phrase again to unlock your encrypted key. Android secures the key with your device.</p>
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
    </main>
  );
}
