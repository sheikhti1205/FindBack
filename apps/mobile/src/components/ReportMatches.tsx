import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import type { PostItem } from "@findback/shared";
import { cancelMatch, confirmMatch, handoverMatch, listMyMatches, proposeMatch, type MyMatch } from "../services/matches";
import type { PossibleMatch } from "../services/similarity";
import { ApiError } from "../services/session";
import { friendlyError } from "../utils/friendlyErrors";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { invalidateFeedCaches } from "../hooks/feedCache";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { PossibleMatches } from "./PossibleMatches";
import { announce } from "./LiveRegion";

interface Props { accountId: string | null; post: PostItem; onChanged: () => void }
type Action = { kind: "propose"; candidate: PossibleMatch } | { kind: "confirm" | "handover" | "cancel"; match: MyMatch };
function message(error: unknown): string {
  // Only this service's closed, locally written error copy may bypass the
  // general taxonomy. No arbitrary SQL/message from another service is echoed.
  if (error instanceof ApiError && error.code?.startsWith("MATCH_")) return error.message;
  return friendlyError(error).message;
}

/** Remount BEFORE paint at an authorization/report identity boundary. Pending
 * results belong to the old instance even across an A→B→A route/account trip. */
export function ReportMatches(props: Props) {
  return <ScopedReportMatches key={`${props.accountId}:${props.post.id}:${props.post.userId}:${props.post.type}`} {...props} />;
}

function ScopedReportMatches({ accountId, post, onChanged }: Props) {
  const owner = !!accountId && accountId === post.userId;
  const alive = useSafetyLifetime();
  const sequence = useRef(0);
  const writing = useRef(false);
  const [matches, setMatches] = useState<MyMatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (before?: { at: string; id: string }) => {
    if (!owner || !accountId) return;
    const seq = ++sequence.current;
    setLoading(true); setListError(null);
    try {
      const rows = await listMyMatches(accountId, { postId: post.id, before });
      if (!alive.current || sequence.current !== seq) return;
      setMatches((previous) => before ? [...previous, ...rows.filter((row) => !previous.some((m) => m.matchId === row.matchId))] : rows);
      setHasMore(rows.length === 20);
    } catch (error) {
      if (alive.current && sequence.current === seq) setListError(message(error));
    } finally {
      if (alive.current && sequence.current === seq) setLoading(false);
    }
  }, [owner, accountId, post.id, alive]);
  useEffect(() => {
    void load();
    const refresh = () => { if (!writing.current) void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      ++sequence.current;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  function review(next: Action) { setActionError(null); setAction(next); }
  async function submit() {
    if (!action || !accountId || !owner || writing.current) return;
    writing.current = true;
    ++sequence.current; // An older pre-write read cannot put stale consent back.
    setSending(true); setActionError(null);
    try {
      let receipt: string;
      if (action.kind === "propose") {
        await proposeMatch(accountId, post.id, action.candidate.post.id);
        receipt = "Proposal sent. The other owner must also agree.";
      } else if (action.kind === "confirm") {
        const result = await confirmMatch(accountId, action.match.matchId);
        receipt = result === "MATCHED" ? "Both owners confirmed the match. Record the handover after the item is returned." : "Your agreement was recorded. Waiting for the other owner.";
      } else if (action.kind === "handover") {
        const result = await handoverMatch(accountId, action.match.matchId);
        receipt = result === "RECOVERED" ? "Both owners recorded the handover. Recovery saved." : "Your handover recorded. Waiting for the other owner.";
      } else {
        await cancelMatch(accountId, action.match.matchId);
        receipt = "Match cancelled.";
      }
      if (!alive.current) return;
      invalidateFeedCaches();
      setNotice(receipt); announce(receipt); setAction(null);
      onChanged();
      // A read-back failure never changes the confirmed write receipt to a
      // failure or invents local relationship state. Keep its own retry inline.
      await load();
    } catch (error) {
      if (alive.current) { const text = message(error); setActionError(text); announce(text); }
    } finally {
      writing.current = false;
      if (alive.current) setSending(false);
    }
  }

  const title = !action ? "" : action.kind === "propose" ? "Propose this match?"
    : action.kind === "confirm" ? "Confirm this match?" : action.kind === "handover" ? "Has the item been handed over?" : "Cancel this match?";
  const confirmation = !action ? "" : action.kind === "propose" ? "Send proposal"
    : action.kind === "confirm" ? "Confirm match" : action.kind === "handover" ? "Yes, record handover" : "Cancel match";
  const last = matches.at(-1);
  return <div className="flex min-w-0 flex-col gap-3">
    {owner && <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Your match activity</h3>
        <button type="button" aria-label="Refresh matches" disabled={loading || sending}
          onClick={() => void load()} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full disabled:opacity-40">
          <RefreshCw size={18} aria-hidden className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
      </div>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {listError && <p role="alert" className="text-sm text-error">{listError}</p>}
      {!loading && !listError && matches.length === 0 && <p className="text-sm text-on-surface-variant">No match proposals yet. A suggestion only becomes a match when both owners agree.</p>}
      {loading && matches.length === 0 && <p role="status" className="text-sm text-on-surface-variant">Loading match activity…</p>}
      <ul className="divide-y divide-outline-variant">
        {matches.map((match) => <li key={match.matchId} className="flex min-w-0 flex-col gap-2 py-3">
          {match.peerAvailable && match.peerReportId
            ? <Link to={`/posts/${match.peerReportId}`} className="break-words text-sm font-medium underline">{match.peerTitle ?? "Other report"}</Link>
            : <p className="text-sm font-medium">Other report unavailable</p>}
          <p className="text-sm text-on-surface-variant">{match.state === "RECOVERED" ? "Recovery complete"
            : match.state === "CANCELLED" ? (match.cancelReason === "SUPERSEDED_BY_CONFIRMED" ? "Another match was confirmed" : match.cancelReason === "REPORT_DELETED" ? "Report removed · match ended" : "Match ended")
            : match.state === "CONFIRMED" ? (match.myHandover ? "Your handover is recorded. Waiting for the other owner." : "Match confirmed · handover not yet complete")
            : match.myConfirmed ? "Waiting for the other owner to agree" : "The other owner proposed this match"}</p>
          <div className="flex flex-wrap gap-2">
            {match.state === "PENDING" && !match.myConfirmed && match.peerAvailable &&
              <Button variant="outline" disabled={sending} onClick={() => review({ kind: "confirm", match })}>Review proposal</Button>}
            {match.state === "CONFIRMED" && !match.myHandover && match.peerAvailable &&
              <Button variant="outline" disabled={sending} onClick={() => review({ kind: "handover", match })}>Record handover</Button>}
            {(match.state === "PENDING" || match.state === "CONFIRMED") &&
              <Button variant="text" disabled={sending} onClick={() => review({ kind: "cancel", match })}>{match.state === "CONFIRMED" ? "Wrong match?" : "Cancel proposal"}</Button>}
            {match.state === "RECOVERED" && <Link to="/returns" className="inline-flex min-h-11 items-center text-sm font-medium underline">View recovery</Link>}
          </div>
        </li>)}
      </ul>
      {hasMore && last && <Button variant="text" disabled={loading || sending}
        onClick={() => void load({ at: last.proposedAt, id: last.matchId })}>Load earlier activity</Button>}
    </>}
    {post.status === "OPEN" && <PossibleMatches post={post} onConfirmMatch={owner ? (candidate) => review({ kind: "propose", candidate }) : undefined} />}
    <BottomSheet open={action !== null} title={title} onClose={() => { if (!sending) setAction(null); }} height="full" dismissible={!sending}>
      <div className="flex min-w-0 flex-col gap-4">
        <p className="break-words text-sm font-medium">{action?.kind === "propose" ? action.candidate.post.title : action?.match.peerTitle ?? "Other report unavailable"}</p>
        <p className="text-sm text-on-surface-variant">{action?.kind === "propose" ? "Only propose this if you believe the reports describe the same item. The other owner must also agree before either report is marked matched."
          : action?.kind === "confirm" ? "Agree only if these reports describe the same item. This does not mark the item recovered. Both owners record the handover separately after the return."
          : action?.kind === "handover" ? "Only record this after the item has actually been returned. Both owners must record the handover to complete the recovery."
          : action?.kind === "cancel" && action.match.state === "CONFIRMED" ? "If this is the wrong match, both reports will reopen. The match history stays recorded. A completed recovery cannot be cancelled here."
          : "This ends the proposal without confirming a match. You can propose a different report later."}</p>
        {actionError && <p role="alert" className="text-sm text-error">{actionError}</p>}
        {actionError ? <Button variant="outline" onClick={() => { setAction(null); void load(); }}>Refresh match status</Button>
          : <Button loading={sending} onClick={() => void submit()}>{confirmation}</Button>}
      </div>
    </BottomSheet>
  </div>;
}
