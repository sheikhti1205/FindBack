import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import { listMyMatches, type MyMatch } from "../services/matches";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { Button } from "./Button";

/** Discovery only: consent, correction and handover stay in ReportMatches.
 * Remount before paint at account boundaries, including an A→B→A trip. */
export function MatchActivity({ accountId }: { accountId: string | null }) {
  return accountId ? <ScopedMatchActivity key={accountId} accountId={accountId} /> : null;
}

function activityLabel(match: MyMatch): string {
  if (match.state === "RECOVERED") return "Recovery complete";
  if (match.state === "CANCELLED") return "Match ended";
  if (!match.peerAvailable) return "Other report unavailable";
  if (match.state === "CONFIRMED") return match.myHandover ? "Waiting for the handover" : "Handover to record";
  return match.myConfirmed ? "Waiting for the other owner" : "Proposal to review";
}

function ScopedMatchActivity({ accountId }: { accountId: string }) {
  const alive = useSafetyLifetime();
  const sequence = useRef(0);
  const [matches, setMatches] = useState<MyMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (before?: { at: string; id: string }) => {
    const seq = ++sequence.current;
    setLoading(true); setError(false);
    try {
      const rows = await listMyMatches(accountId, before ? { before } : {});
      if (!alive.current || sequence.current !== seq) return;
      setMatches((previous) => {
        const merged = before ? [...previous] : [];
        const seen = new Set(merged.map((row) => row.matchId));
        for (const row of rows) {
          if (!seen.has(row.matchId)) { merged.push(row); seen.add(row.matchId); }
        }
        return merged;
      });
      setHasMore(rows.length === 20);
    } catch {
      if (alive.current && sequence.current === seq) setError(true);
    } finally {
      if (alive.current && sequence.current === seq) setLoading(false);
    }
  }, [accountId, alive]);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++sequence.current;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  // Presence only, not an account-wide count inferred from a bounded page.
  const actionWaiting = matches.some((match) => !!match.myReportId && match.peerAvailable && (
    (match.state === "PENDING" && !match.myConfirmed) || (match.state === "CONFIRMED" && !match.myHandover)
  ));
  const last = matches.at(-1);
  return <details className="group mx-4 mb-3 min-w-0 border-b border-outline-variant">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2">
      <span>Match activity</span>
      {actionWaiting && <span className="ml-2 inline-block text-xs text-on-surface-variant">Action waiting</span>}
    </summary>
    <div className="flex min-w-0 flex-col gap-2 pb-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-on-surface-variant">Review proposals and handovers across your reports.</p>
        <button type="button" aria-label="Refresh match activity" disabled={loading}
          onClick={() => void load()} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40">
          <RefreshCw size={18} aria-hidden className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-error">Couldn't load match activity. Try again.</p>}
      {loading && matches.length === 0 && <p role="status" className="text-sm text-on-surface-variant">Loading match activity…</p>}
      {!loading && !error && matches.length === 0 && <p className="text-sm text-on-surface-variant">No match activity yet.</p>}
      <ul className="divide-y divide-outline-variant" aria-busy={loading}>
        {matches.map((match) => <li key={match.matchId} className="min-w-0 py-2">
          {match.myReportId ? <Link to={`/posts/${match.myReportId}#detail-matches`}
            className="flex min-h-11 min-w-0 flex-col justify-center gap-1 break-words py-1 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2">
            <span className="text-sm font-medium underline">{match.myTitle ?? "Your report"}</span>
            <span className="text-sm text-on-surface-variant">{activityLabel(match)}</span>
          </Link> : <>
            <p className="text-sm font-medium">Report removed</p>
            <p className="text-sm text-on-surface-variant">{activityLabel(match)}</p>
          </>}
          {match.peerAvailable && match.peerTitle && <p className="break-words text-sm text-on-surface-variant">{match.peerTitle}</p>}
        </li>)}
      </ul>
      {hasMore && last && <Button variant="text" disabled={loading}
        onClick={() => void load({ at: last.proposedAt, id: last.matchId })}>Load earlier activity</Button>}
    </div>
  </details>;
}
