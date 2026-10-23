import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { announce } from "./LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
import { blockUser, listMyBlocks, unblockUser } from "../services/blocks";
import { UNAVAILABLE_SENTENCES } from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";

export interface BlockControlProps {
  userId: string;
  name: string;
  /** Confirmed VIEWER-OWNED OUTGOING membership only, never the mutual blocked bit. */
  blocked?: boolean;
  /** blocked is outgoing membership; stillHidden is the direction-free server result. */
  onChanged?: (state: { blocked: boolean; stillHidden: boolean }) => void;
  className?: string;
}

/** Account and target identity delimit all state, pending reads and writes. */
export function BlockControl(props: BlockControlProps) {
  const { user } = useAuth();
  if (!user || user.id === props.userId) return null;
  return <ScopedBlockControl key={`${user.id}:${props.userId}`} {...props} />;
}

function ScopedBlockControl({ userId, name, blocked, onChanged, className }: BlockControlProps) {
  const alive = useSafetyLifetime();
  const [known, setKnown] = useState<boolean | null>(blocked ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    setKnown(blocked ?? null);
    if (blocked !== undefined) return;
    // Only the caller's outgoing list can answer which action to offer.
    void listMyBlocks().then((rows) => {
      if (current && alive.current) setKnown(rows.some((row) => row.userId === userId));
    }).catch((err: unknown) => {
      if (current && alive.current) setError(blockFailure(err));
    });
    return () => { current = false; };
  }, [userId, blocked, attempt, alive]);

  const act = async () => {
    if (busy || known === null) return;
    const question = known
      ? `Unblock ${name}? You will see each other again unless they have blocked you.`
      : `Block ${name}? Blocking hides each of you from the other: you won't see their reports, comments or notifications, and they won't see yours either. They are not told that you blocked them.`;
    if (!window.confirm(question)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      let stillHidden = true;
      if (known) {
        stillHidden = (await unblockUser(userId)).stillHidden;
      } else {
        await blockUser(userId);
      }
      if (!alive.current) return;
      const next = !known;
      setKnown(next);
      // Identical conditional copy for BOTH unblock results: never infer inbound direction.
      const outcome = next
        ? `You blocked ${name}. You won't see each other from now on.`
        : `You've unblocked ${name}. You still won't see each other if they've blocked you.`;
      setMessage(outcome); announce(outcome);
      onChanged?.({ blocked: next, stillHidden });
    } catch (err) {
      if (!alive.current) return;
      const sentence = blockFailure(err);
      setError(sentence); announce(sentence);
    } finally { if (alive.current) setBusy(false); }
  };
  return <div className={`min-w-0 break-words ${className ?? ""}`}>
    <button type="button" onClick={() => void act()} disabled={busy || known === null}
      aria-busy={busy || undefined} data-testid="block-control"
      className="inline-flex min-h-[48px] max-w-full items-center justify-center whitespace-normal rounded-m3-md border border-outline px-4 py-2 text-sm font-medium text-on-surface [overflow-wrap:anywhere] hover:bg-surface-container disabled:opacity-50">
      {known === null ? (error ? "Block status unavailable" : "Checking…") : known ? `Unblock ${name}` : `Block ${name}`}
    </button>
    {message && <p role="status" data-testid="block-outcome">{message}</p>}
    {error && <p role="alert" data-testid="block-error">{error}</p>}
    {error && known === null && <button type="button" className="min-h-[44px] px-3" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
  </div>;
}

function blockFailure(err: unknown): string {
  return isMissingServerFunction(err) ? UNAVAILABLE_SENTENCES.block : friendlyError(err).message;
}
