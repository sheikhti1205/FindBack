import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { PublicIdentity } from "./UserIdentityTrigger";
import { useAuth } from "../auth";
import { useMessaging } from "../services/messaging/useMessaging";
import { requestMessagingConversation, refreshMessaging, sendMessagingText } from "../services/messaging/runtime";
import { MAX_BODY_UNITS } from "../services/messaging/validation";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import { ComposerShell } from "./ComposerShell";
import { SafetyActions } from "./SafetyActions";
import { UserAvatar } from "./UserAvatar";

/** Account/peer/report key invalidates drafts and async continuations synchronously. */
export function PeerIdentityActions({ person }: { person: PublicIdentity }) {
  const { user } = useAuth();
  if (!user || user.id === person.id) return null;
  return <PeerActionsSession key={JSON.stringify([user.id, person.id, person.contextReportId])} accountId={user.id} person={person} />;
}

function PeerActionsSession({ accountId, person }: { accountId: string; person: PublicIdentity }) {
  const chat = useMessaging();
  const navigate = useNavigate();
  const alive = useSafetyLifetime();
  const sending = useRef(false);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkConversation, setCheckConversation] = useState<string | null>(null);
  // Relationship authority exists only after a completed refresh. Cached or
  // offline projections are not current authority, so they are never shown or
  // used to infer a relationship; an offline chat still opens the dialog and
  // explains itself instead of leaving a dead button.
  const ready = chat.accountId === accountId && chat.status === "ready";
  const projection = ready
    ? Object.values(chat.currentProjections ?? {}).find(row => row.peerId === person.id)
    : undefined;
  // `closed` is also the state a foreign account's snapshot renders as, so
  // treat anything that is not this account's live runtime as still opening.
  const opening = chat.accountId !== accountId || chat.status === "opening" || chat.status === "closed";
  const name = person.displayName?.trim() || person.username;
  // Report-linked contact keeps its subject visible in the action label and in
  // the first message, so the recipient is never asked to guess why.
  const reportId = person.contextReportId;

  /** An explicit retry, so an offline or failed runtime is recoverable from
   *  here instead of requiring a visit to Chats first. */
  async function retryChat() {
    if (retrying) return;
    setRetrying(true); setError(null);
    try {
      await refreshMessaging(accountId);
    } catch {
      // The snapshot carries the reason; the dialog re-renders from it.
    } finally {
      if (alive.current) setRetrying(false);
    }
  }

  async function sendRequest() {
    if (!ready || sending.current || checkConversation || !body.trim() || body.length > MAX_BODY_UNITS) return;
    sending.current = true; setBusy(true); setError(null);
    let conversationId: string | null = null;
    try {
      if (projection) {
        setCheckConversation(projection.conversationId);
        setError("This conversation has changed. Open the chat to continue.");
        return;
      }
      conversationId = await requestMessagingConversation(accountId, person.id);
      if (!alive.current) return;
      await sendMessagingText(accountId, conversationId, person.id, body.trim(), reportId);
      if (alive.current) navigate(`/chats/${encodeURIComponent(conversationId)}`);
    } catch {
      if (!alive.current) return;
      // A send can persist before a later reload fails. Never invite a blind
      // second send; the existing durable chat owns inspection/retry from here.
      setCheckConversation(conversationId);
      setError(conversationId
        ? "We couldn't confirm the send. Open the chat to check before trying again."
        : "Couldn't start this conversation. Check your connection and try again.");
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (projection?.ownBlocked) return null;
  // §9 quick card: the conversation is the canonical owner of relationship
  // options, so a connected card routes to it instead of duplicating accept /
  // decline / end policy here. Outgoing requests name the action they perform.
  const conversationHref = projection
    ? `/chats/${encodeURIComponent(projection.conversationId)}${reportId ? `?report=${encodeURIComponent(reportId)}` : ""}`
    : null;
  return <div className="fb-peer-actions">
    {ready && projection && <>
      <p className="fb-identity-relationship">{projection.mode === "CONNECTED" ? "Connected"
        : projection.request === "OUTGOING" ? "Request sent" : "Message request"}</p>
      <Link className="fb-surface-button" to={conversationHref!}>
        {projection.mode === "CONNECTED" ? reportId ? "Message about this report" : "Message"
          : projection.request === "OUTGOING" ? "Open request conversation" : "View request"}
      </Link>
      {projection.mode === "CONNECTED" && <Link className="fb-surface-button" to={`/chats/${encodeURIComponent(projection.conversationId)}`}>Connection options</Link>}
    </>}
    {!projection && <button type="button" className="fb-surface-button"
      onClick={() => setOpen(true)}>{reportId ? "Connect about this report" : "Connect"}</button>}
    {/* §9 safety rows: the canonical safety owner supplies Report user and
        Block user; this card composes it rather than adding a second control. */}
    <SafetyActions reportPerson person={{ userId: person.id, name }} />
    <AdaptiveTaskSurface open={open} onClose={() => setOpen(false)} busy={busy}
      title={reportId ? `Message ${name} about this report` : `Connect with ${name}`}
      description={reportId
        ? "Your message will show which report you’re asking about. Photos and location unlock once they accept."
        : "Introduce yourself with a message. Photos and location unlock once they accept."}>
      <div className="fb-identity-header mb-4">
        <UserAvatar username={name} avatarUrl={person.avatarUrl} size={40} />
        <div className="min-w-0"><p className="fb-identity-name font-semibold">{name}</p><p className="fb-identity-handle">@{person.username}</p></div>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-error">{error}</p>}
      {!ready ? (
        // Chat is a real feature, not a hidden one: say which state it is in and
        // offer the retry here rather than leaving a disabled control with no
        // explanation of how to get past it.
        <div data-testid="connect-status" role="status">
          <p className="mb-3 text-sm text-on-surface-variant">{opening
            ? "Opening your chats…"
            : chat.status === "offline"
              ? "You’re offline, or Chat couldn’t sync. Check your connection and try again."
              : chat.error ?? "Chat couldn’t open. Try again in a moment."}</p>
          {!opening && <button type="button" className="fb-surface-button" disabled={retrying}
            onClick={() => void retryChat()}>{retrying ? "Trying again…" : "Try again"}</button>}
        </div>
      ) : checkConversation ? <Link className="fb-surface-button" to={`/chats/${encodeURIComponent(checkConversation)}`}>Open chat to check</Link> : <>
        <ComposerShell value={body} onChange={setBody} inputLabel="First message" placeholder="Write a message…"
          onSend={() => { void sendRequest(); }} sendLabel="Send request" busy={busy} disabled={busy}
          canSend={Boolean(body.trim()) && body.length <= MAX_BODY_UNITS} />
        {body.length > MAX_BODY_UNITS && <p role="alert" className="mt-2 text-sm text-error">Your message is too long.</p>}
      </>}
    </AdaptiveTaskSurface>
  </div>;
}
