import { useEffect, useRef, useState } from "react";
import { CheckCheck, MessagesSquare } from "lucide-react";
import { useAuth } from "../auth";
import { SettingsGroup, SettingsPage, SettingsRow, PreferenceSwitchRow } from "../components/settings";
import { fetchMessagingPreferences, setMessagingPreference } from "../services/messaging/runtime";
import { useMessaging } from "../services/messaging/useMessaging";
import type { MessagingPreferences } from "../services/messaging/session";

export function MessagingPrivacy() {
  const { user } = useAuth();
  return user ? <MessagingPrivacySession key={user.id} accountId={user.id} /> : null;
}

function MessagingPrivacySession({ accountId }: { accountId: string }) {
  const chat = useMessaging();
  const available = chat.status === "ready" || chat.status === "offline";
  const [preferences, setPreferences] = useState<MessagingPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    setError(null);
    void fetchMessagingPreferences(accountId).then((next) => {
      if (!cancelled) setPreferences(next);
    }).catch(() => {
      if (!cancelled) setError("Your message settings could not load. Check your connection and try again.");
    });
    return () => { cancelled = true; };
  }, [accountId, available, attempt]);

  async function change(key: keyof MessagingPreferences, enabled: boolean) {
    if (busy || !preferences) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const next = await setMessagingPreference(accountId, key, enabled);
      if (alive.current) { setPreferences(next); setSaved(true); }
    } catch {
      // A failed read-back can follow a successful write. Do not assert rollback.
      if (alive.current) setError("Could not confirm your saved setting. Try reloading before changing it again.");
    } finally { if (alive.current) setBusy(false); }
  }
  return <SettingsPage title="Messages" backTo="/settings/privacy" backLabel="Back to Privacy">
    <SettingsGroup title="Who can message you" description="New people send requests by default. You choose when to connect.">
      {preferences && <PreferenceSwitchRow title="Allow direct messages" icon={MessagesSquare}
        description="Let new people start a conversation without waiting for you to accept. Changing this won’t accept your pending requests."
        checked={preferences.openMessages} disabled={busy || !!error || chat.status !== "ready"}
        onChange={(enabled) => void change("openMessages", enabled)} />}
    </SettingsGroup>
    <SettingsGroup title="Read receipts" description="Never shared for message requests.">
      {preferences && <PreferenceSwitchRow title="Read receipts" icon={CheckCheck}
        description="In connected chats, both people must enable receipts to see when messages are read."
        checked={preferences.readReceipts} disabled={busy || !!error || chat.status !== "ready"}
        onChange={(enabled) => void change("readReceipts", enabled)} />}
    </SettingsGroup>
    {!preferences && !error && <p role="status" className="text-sm text-on-surface-variant">{chat.status === "error"
      ? "Your chats could not open. Go to Connections to try syncing again." : "Loading message settings…"}</p>}
    {busy && <p role="status" className="text-sm text-on-surface-variant">Saving…</p>}
    {saved && <p role="status" className="text-sm text-on-surface-variant">Settings saved.</p>}
    {error && <div><p role="alert" className="text-sm text-error">{error}</p>
      <button type="button" className="min-h-[44px] px-2 underline" disabled={busy} onClick={() => { setSaved(false); setAttempt((value) => value + 1); }}>Reload settings</button></div>}
    <SettingsGroup>
      <SettingsRow title="Connections" route="/connections" />
      <SettingsRow title="Blocked accounts" route="/settings/privacy/blocked" />
      <SettingsRow title="Privacy policy" route="/settings/privacy-policy" />
    </SettingsGroup>
  </SettingsPage>;
}
