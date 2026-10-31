import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { PublicIdentity } from "./UserIdentityTrigger";
import { useAuth } from "../auth";
import { useMessaging } from "../services/messaging/useMessaging";
import { requestMessagingConversation, sendMessagingText } from "../services/messaging/runtime";
import { MAX_BODY_UNITS } from "../services/messaging/validation";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import { ComposerShell } from "./ComposerShell";
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
  const [error, setError] = useState<string | null>(null);
  const [checkConversation, setCheckConversation] = useState<string | null>(null);
  // Cached/offline projections are not current relationship authority. Do not
  // disclose counterpart decline/hide/block or infer it from a request failure.
  const projection = Object.values(chat.currentProjections ?? {}).find(row => row.peerId === person.id);
  const available = chat.accountId === accountId && chat.status === "ready" && chat.currentProjections !== null;
  const name = person.displayName?.trim() || person.username;
  // Report-linked contact keeps its subject visible in the action label and in
  // the first message, so the recipient is never asked to guess why.
  const reportId = person.contextReportId;

  async function sendRequest() {
    if (!available || sending.current || checkConversation || !body.trim() || body.length > MAX_BODY_UNITS) return;
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
  return <div className="fb-peer-actions">
    {available && projection && <>
      <p className="fb-identity-relationship">{projection.mode === "CONNECTED" ? "Connected"
        : projection.request === "OUTGOING" ? "Request sent" : "Message request"}</p>
      <Link className="fb-surface-button" to={`/chats/${encodeURIComponent(projection.conversationId)}${reportId ? `?report=${encodeURIComponent(reportId)}` : ""}`}>
        {projection.mode === "CONNECTED" ? reportId ? "Message about this report" : "Message" : "View request"}
      </Link>
    </>}
    {(!projection || !available) && <button type="button" className="fb-surface-button" disabled={!available}
      onClick={() => setOpen(true)}>{reportId ? "Connect about this report" : "Connect"}</button>}
    <AdaptiveTaskSurface open={open} onClose={() => setOpen(false)} busy={busy}
      title={reportId ? `Message ${name} about this report` : `Connect with ${name}`}
      description={reportId
        ? "Your message will show which report you’re asking about. Photos and location are available after you connect."
        : "Introduce yourself with a message. Photos and location are available after you connect."}>
      <div className="fb-identity-header mb-4">
        <UserAvatar username={name} avatarUrl={person.avatarUrl} size={40} />
        <div className="min-w-0"><p className="fb-identity-name font-semibold">{name}</p><p className="fb-identity-handle">@{person.username}</p></div>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-error">{error}</p>}
      {checkConversation ? <Link className="fb-surface-button" to={`/chats/${encodeURIComponent(checkConversation)}`}>Open chat to check</Link> : <>
        <ComposerShell value={body} onChange={setBody} inputLabel="First message" placeholder="Write a message…"
          onSend={() => { void sendRequest(); }} sendLabel="Send request" busy={busy} disabled={!available || busy}
          canSend={Boolean(body.trim()) && body.length <= MAX_BODY_UNITS} />
        {body.length > MAX_BODY_UNITS && <p role="alert" className="mt-2 text-sm text-error">Your message is too long.</p>}
      </>}
    </AdaptiveTaskSurface>
  </div>;
}
