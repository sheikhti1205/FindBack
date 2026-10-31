import { useEffect, useRef, useState } from "react";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import { LocationPicker, type LocationValue } from "./LocationPicker";
import { copyStaticLocation } from "../services/messaging/validation";
import type { StaticLocation } from "../services/messaging/history";

/** A reviewed, static pin. Uses the report picker's permission/manual/privacy
 * owner, but never stores or sends its unrounded local-only coordinates. */
export function ChatLocationComposer({ onClose, onSend }: {
  onClose: () => void; onSend: (location: StaticLocation) => Promise<void>;
}) {
  const [value, setValue] = useState<LocationValue>({ label: "", latitude: null, longitude: null });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  let location: StaticLocation | null = null;
  try {
    if (value.latitude !== null && value.longitude !== null) location = copyStaticLocation({
      lat: value.latitude, lng: value.longitude, accuracy: value.accuracy ?? null,
    });
  } catch { /* Invalid fixes cannot enable Send. Manual selection remains available. */ }
  async function send() {
    if (!location || pending.current || !alive.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await onSend(location); if (alive.current) onClose(); }
    catch { if (alive.current) setError("Your location could not be shared. Check your connection and try again."); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <AdaptiveTaskSurface open onClose={onClose} title="Share a location">
    <div className="fb-chat-location-composer">
      <p className="fb-chat-secondary">Choose a pin to share in this chat. It won’t update as you move.</p>
      <LocationPicker value={value} onChange={setValue} disabled={busy} visibility="conversation" />
      {error && <p role="alert" className="fb-chat-error">{error}</p>}
      <div className="fb-chat-confirm-actions">
        <button type="button" className="fb-surface-button" onClick={onClose}>Cancel</button>
        <button type="button" className="fb-surface-button" disabled={!location || busy} onClick={() => void send()}>
          {busy ? "Sending location…" : "Send location"}
        </button>
      </div>
    </div>
  </AdaptiveTaskSurface>;
}
