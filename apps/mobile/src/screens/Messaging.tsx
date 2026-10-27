import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Bell, Ellipsis, RefreshCw, Send } from "lucide-react";
import { useAuth } from "../auth";
import { UserAvatar } from "../components/UserAvatar";
import { BottomSheet } from "../components/BottomSheet";
import { BlockControl } from "../components/BlockControl";
import { ReportSheet } from "../components/ReportSheet";
import { announce } from "../components/LiveRegion";
import { fetchAccountLabels } from "../services/accountLabels";
import { useMessaging } from "../services/messaging/useMessaging";
import {
  changeMessagingRelationship, markMessagingConversationRead, readMessagingThreadState,
  refreshMessaging, sendMessagingText, clearMessagingConversation, removeMessagingMessage,
  fetchMessagingReceiptView, observeMessagingReceipt,
} from "../services/messaging/runtime";
import type { OutboxEntry, StoredHumanMessage } from "../services/messaging/history";
import "./Messaging.css";

function useLabels(peerIds: string[]) {
  const key = [...new Set(peerIds)].sort().join(",");
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    if (key) void fetchAccountLabels(key.split(",")).then((next) => {
      if (!cancelled) setLabels(next);
    }).catch(() => undefined); // Missing labels never imply a deleted account.
    return () => { cancelled = true; };
  }, [key]);
  return labels;
}

function RetrySync({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <>
    <button className="fb-chat-icon" type="button" aria-label="Sync messages" disabled={busy}
      onClick={() => {
        setBusy(true); setError(false);
        void refreshMessaging(accountId).catch(() => setError(true)).finally(() => setBusy(false));
      }}><RefreshCw size={19} aria-hidden="true" className={busy ? "fb-chat-refreshing" : ""} /></button>
    {error && <span role="status" className="fb-chat-secondary">Could not sync.</span>}
  </>;
}

export function Connections() {
  const { user } = useAuth();
  return user ? <ConnectionsSession key={user.id} accountId={user.id} /> : null;
}

function ConnectionsSession({ accountId }: { accountId: string }) {
  const chat = useMessaging();
  const [filter, setFilter] = useState("All");
  const heading = useRef<HTMLHeadingElement>(null);
  const labels = useLabels(chat.conversations.map((row) => row.peerId));
  useEffect(() => { heading.current?.focus(); }, []);
  const rows = chat.conversations.filter((row) => {
    const view = chat.currentProjections?.[row.conversationId] ?? row.cachedProjection;
    const dismissed = view?.ownHidden || view?.ownDeclined;
    if (filter === "Hidden") return dismissed;
    if (dismissed) return false;
    if (filter === "Requests") return view?.mode === "REQUEST" && view.request !== "NONE";
    if (filter === "Connected") return view?.mode === "CONNECTED";
    return true;
  });
  return <section className="fb-chat-page" aria-label="Connections">
    <header className="fb-chat-header">
      <Link to="/profile" className="fb-chat-icon" aria-label="Back to profile"><ArrowLeft size={22} aria-hidden="true" /></Link>
      <h1 ref={heading} tabIndex={-1}>Connections</h1>
      <RetrySync accountId={accountId} />
      <Link to="/notifications" className="fb-chat-icon" aria-label="Notifications"><Bell size={21} aria-hidden="true" /></Link>
    </header>
    <div className="fb-chat-filters" role="group" aria-label="Show conversations">
      {["All", "Requests", "Connected", "Hidden"].map((value) => <button key={value} type="button"
        aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}
    </div>
    <div className="fb-chat-list">
      <p className="fb-chat-sync" role="status">{chat.status === "opening" ? "Opening your chats…"
        : chat.error ?? (chat.status === "offline" ? "You’re offline. Saved chats are still available." : "")}</p>
      {rows.length === 0 && chat.status !== "opening" && <div className="fb-chat-empty">
        <h2>{filter === "All" ? "Your conversations start here" : `No ${filter.toLowerCase()} conversations`}</h2>
        <p>{chat.status === "error" ? "Your chat history could not open. Use Sync messages to try again."
          : "Open someone’s profile to send a message. New people can reply after accepting your request."}</p>
      </div>}
      <ul>
        {rows.map((row) => {
          const name = labels.get(row.peerId);
          const view = chat.currentProjections?.[row.conversationId] ?? row.cachedProjection;
          const state = view?.ownBlocked ? "Blocked by you" : view?.ownHidden ? "Hidden"
            : view?.ownDeclined ? "Dismissed" : view?.mode === "CONNECTED" ? "Connected"
              : view?.request === "INCOMING" ? "Message request" : view?.request === "OUTGOING" ? "Request sent" : "Conversation";
          return <li key={row.conversationId}>
            <Link to={`/connections/${row.conversationId}`} className="fb-chat-row">
              <UserAvatar username={name} size={40} />
              <span className="fb-chat-row-copy"><strong>{name ? `@${name}` : "Member"}</strong>
                <span className="fb-chat-preview">{row.lastMessage?.unsentAt !== undefined ? "Message unsent"
                  : row.lastMessage?.body || state}</span>
                {row.lastMessage && <span className="fb-chat-secondary">{state}{!chat.currentProjections ? " · Saved chat" : ""}</span>}
              </span>
              {row.unreadCount > 0 && <span className="fb-chat-unread" aria-label={`${row.unreadCount} unread messages`}>{row.unreadCount}</span>}
            </Link>
          </li>;
        })}
      </ul>
    </div>
  </section>;
}

export function MessagingThread() {
  const { user } = useAuth();
  const { conversationId = "" } = useParams();
  return user ? <ThreadSession key={`${user.id}:${conversationId}`} accountId={user.id} conversationId={conversationId} /> : null;
}

function ThreadSession({ accountId, conversationId }: { accountId: string; conversationId: string }) {
  const chat = useMessaging();
  const row = chat.conversations.find((entry) => entry.conversationId === conversationId);
  const current = chat.currentProjections?.[conversationId];
  const view = current ?? row?.cachedProjection;
  const labels = useLabels(row ? [row.peerId] : []);
  const name = row ? labels.get(row.peerId) : undefined;
  const [messages, setMessages] = useState<StoredHumanMessage[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"actions" | "end" | "message" | "delete" | "unsend" | "clear" | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [receipt, setReceipt] = useState<{ projections: typeof chat.currentProjections; readIds: Set<string> } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastMarked = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; heading.current?.focus();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (chat.accountId !== accountId || chat.status === "opening" || chat.status === "closed") return;
    let cancelled = false;
    void readMessagingThreadState(accountId, conversationId).then((state) => {
      if (cancelled) return;
      setMessages(state.messages); setOutbox(state.outbox); setLoaded(true);
    }).catch(() => { if (!cancelled) setError("Your saved messages could not open. Try syncing again."); });
    return () => { cancelled = true; };
  }, [accountId, conversationId, chat.accountId, chat.status, chat.revision]);
  useLayoutEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  const highest = messages.reduce((maximum, message) => Math.max(maximum, message.server?.sequence ?? 0), 0);
  useEffect(() => {
    const area = scroll.current;
    if (!area || !loaded) return;
    const checkRead = () => {
      nearBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 32;
      if (document.visibilityState !== "visible" || !nearBottom.current || highest <= lastMarked.current) return;
      lastMarked.current = highest;
      void markMessagingConversationRead(accountId, conversationId, highest).catch(() => { lastMarked.current = 0; });
    };
    checkRead();
    area.addEventListener("scroll", checkRead, { passive: true });
    document.addEventListener("visibilitychange", checkRead);
    return () => {
      area.removeEventListener("scroll", checkRead);
      document.removeEventListener("visibilitychange", checkRead);
    };
  }, [accountId, conversationId, highest, loaded]);

  // This is live, disposable receipt authority, never the stored unread cursor.
  // A fetched context precedes a fresh geometric observation of an inbound bubble.
  useLayoutEffect(() => {
    setReceipt(null);
    const area = scroll.current;
    const projections = chat.currentProjections;
    if (!area || !loaded || !visible || sheet !== null || reportOpen || chat.accountId !== accountId || chat.status !== "ready"
      || !projections || current?.mode !== "CONNECTED" || current.ownBlocked) return;
    const controller = new AbortController();
    let context: string | null = null;
    let lastObserved: string | null = null;
    let requestedKey: string | null = null;
    let wantedIds: string[] = [];
    let version = 0;
    let running = false;
    let frame = 0;
    const lookup = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        while (!controller.signal.aborted) {
          const ticket = version;
          const ids = wantedIds;
          const batches = ids.length ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100)) : [[]];
          let batchContext: string | null | undefined;
          const readIds = new Set<string>();
          let mismatched = false;
          for (const batch of batches) {
            const result = await fetchMessagingReceiptView(accountId, conversationId, batch, controller.signal);
            if (controller.signal.aborted || ticket !== version || document.visibilityState !== "visible") break;
            if (batchContext === undefined) {
              batchContext = result.context;
              if (context !== batchContext) { context = null; lastObserved = null; setReceipt(null); }
            }
            else if (batchContext !== result.context) { mismatched = true; break; }
            for (const id of result.readIds) readIds.add(id);
          }
          if (controller.signal.aborted || document.visibilityState !== "visible") return;
          if (ticket !== version) continue;
          if (mismatched || batchContext === undefined) {
            context = null;
            lastObserved = null;
            setReceipt(null);
            requestedKey = null;
            return;
          }
          if (context !== batchContext) lastObserved = null;
          context = batchContext;
          setReceipt({ projections, readIds });
          checkVisible();
          if (ticket !== version) continue;
          return;
        }
      } catch {
        if (!controller.signal.aborted) { context = null; lastObserved = null; requestedKey = null; setReceipt(null); }
      } finally { running = false; }
    };
    const checkVisible = () => {
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      const container = area.getBoundingClientRect();
      const candidates = messages.filter((message) => message.server && message.unsentAt === undefined);
      const visibleOwn: string[] = [];
      const bubbles = new Map(Array.from(area.querySelectorAll<HTMLElement>("[data-receipt-message]"),
        (element) => [element.dataset.receiptMessage, element] as const));
      let boundary: StoredHumanMessage | undefined;
      for (const message of candidates) {
        const bubble = bubbles.get(message.id);
        if (!bubble) continue;
        const bounds = bubble.getBoundingClientRect();
        if (bounds.bottom <= Math.max(container.top, 0) || bounds.top >= Math.min(container.bottom, window.innerHeight)
          || bounds.right <= Math.max(container.left, 0) || bounds.left >= Math.min(container.right, window.innerWidth)) continue;
        if (message.authorId === accountId) visibleOwn.push(message.id);
        else if (!boundary || message.server!.sequence > boundary.server!.sequence) boundary = message;
      }
      const key = JSON.stringify(visibleOwn);
      if (key !== requestedKey) {
        requestedKey = key;
        wantedIds = visibleOwn;
        version += 1;
        void lookup();
      }
      if (!context || !boundary || lastObserved === boundary.id) return;
      const id = boundary.id;
      lastObserved = id;
      void observeMessagingReceipt(accountId, conversationId, context, id, controller.signal)
        .then((accepted) => { if (!accepted && lastObserved === id) lastObserved = null; })
        .catch(() => { if (lastObserved === id) lastObserved = null; });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; checkVisible(); });
    };
    area.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      controller.abort();
      if (frame) window.cancelAnimationFrame(frame);
      area.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [accountId, conversationId, chat.accountId, chat.status, chat.currentProjections, current, loaded, messages, visible, sheet, reportOpen]);

  async function relationship(action: "accept" | "end" | "hide" | "unhide" | "decline") {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await changeMessagingRelationship(accountId, conversationId, action);
      if (alive.current) { setSheet(null); announce("Conversation refreshed."); }
    } catch { if (alive.current) setError("That change could not be saved. Try again."); }
    finally { if (alive.current) setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!row || busy || !draft.trim()) return;
    setBusy(true); setError(null);
    try {
      await sendMessagingText(accountId, conversationId, row.peerId, draft);
      if (alive.current) { nearBottom.current = true; setDraft(""); announce("Message saved. Sending."); }
    } catch { if (alive.current) setError("Your message could not be saved. Your text is still here."); }
    finally { if (alive.current) { setBusy(false); composer.current?.focus(); } }
  }
  const selectedMessage = messages.find((message) => message.id === selectedMessageId);
  async function erase(action: "delete" | "unsend" | "clear") {
    if (busy || !current) return;
    if (action !== "clear" && !selectedMessage?.server) return;
    if (action === "unsend" && (selectedMessage?.authorId !== accountId || selectedMessage.unsentAt !== undefined)) return;
    setBusy(true); setError(null);
    try {
      if (action === "clear") await clearMessagingConversation(accountId, conversationId, highest);
      else if (selectedMessage) await removeMessagingMessage(accountId, conversationId, selectedMessage.id, action === "unsend");
      if (alive.current) { setSheet(null); setSelectedMessageId(null); announce(action === "unsend" ? "Message unsent." : "Your chat was updated."); }
    } catch {
      if (alive.current) setError("Could not confirm this change. Sync and check your chat before trying again.");
    } finally { if (alive.current) setBusy(false); }
  }
  const canCompose = !!row && !view?.ownBlocked && (view?.mode === "CONNECTED" || view?.request !== "INCOMING");
  return <section className="fb-chat-page" aria-label="Conversation">
    <header className="fb-chat-header">
      <Link to="/connections" className="fb-chat-icon" aria-label="Back to connections"><ArrowLeft size={22} aria-hidden="true" /></Link>
      <UserAvatar username={name} size={32} />
      <div className="fb-chat-heading"><h1 ref={heading} tabIndex={-1}>{name ? `@${name}` : "Conversation"}</h1>
        <p className="fb-chat-secondary">{!current ? "Saved chat" : current.mode === "CONNECTED" ? "Connected" : "Message request"}</p></div>
      <button type="button" className="fb-chat-icon" aria-label="Conversation options" onClick={() => setSheet("actions")}><Ellipsis size={22} aria-hidden="true" /></button>
    </header>
    <div className="fb-chat-messages" ref={scroll}>
      <p className="fb-chat-sync" role="status">{chat.error ?? (chat.status === "offline" ? "You’re offline. Messages will send when you reconnect." : "")}</p>
      {!loaded && <p role="status" className="fb-chat-secondary">Opening messages…</p>}
      {loaded && messages.length === 0 && <p className="fb-chat-empty">{view?.request === "INCOMING" ? "A new message request."
        : "Say hello and explain why you’d like to connect."}</p>}
      {view?.mode === "REQUEST" && <div className="fb-chat-request">
        <p>{view.request === "INCOMING" ? "Accept to reply. Photos and read receipts stay off until you connect."
          : view.request === "OUTGOING" ? "Request sent. You can add another message while you wait."
            : "Send a text message to start a request."}</p>
        {view.request === "INCOMING" && <div className="fb-chat-actions">
          <button type="button" disabled={busy || !current || view.ownBlocked} onClick={() => void relationship("accept")}>Accept</button>
          <button type="button" disabled={busy || !current} onClick={() => void relationship("decline")}>Decline</button>
        </div>}
      </div>}
      <ol className="fb-chat-transcript" aria-label="Messages">
        {messages.map((message) => {
          const own = message.authorId === accountId;
          const pending = outbox.find((entry) => entry.messageId === message.id);
          return <li key={message.id} className={own ? "fb-chat-line fb-chat-line-own" : "fb-chat-line"}>
            <div data-receipt-message={message.id} className={own ? "fb-chat-message fb-chat-message-own" : "fb-chat-message"}>
            <span className="sr-only">{own ? "You: " : `${name ? `@${name}` : "Member"}: `}</span>
            <p dir="auto">{message.unsentAt !== undefined ? "Message unsent" : message.body}</p>
            {own && <span className="fb-chat-message-status">{message.server ? (visible && chat.status === "ready" && current?.mode === "CONNECTED" && !current.ownBlocked
              && message.unsentAt === undefined && receipt?.projections === chat.currentProjections && receipt.readIds.has(message.id) ? "Read" : "Sent") : pending?.status === "FAILED" ? "Failed — " : "Sending…"}
              {!message.server && pending?.status === "FAILED" && <button type="button" onClick={() => void refreshMessaging(accountId).catch(() => setError("Could not retry. Try syncing again."))}>Retry</button>}</span>}
            </div>
            {message.server && <button type="button" className="fb-chat-icon fb-chat-message-options" aria-label={own ? "Options for your message" : "Options for received message"}
              onClick={() => { setSelectedMessageId(message.id); setSheet("message"); }}><Ellipsis size={16} aria-hidden="true" /></button>}
          </li>;
        })}
      </ol>
      {view?.ownBlocked && <p className="fb-chat-secondary">You’ve blocked this account. Manage blocked accounts in Privacy settings.</p>}
    </div>
    {error && <p className="fb-chat-error" role="alert">{error}</p>}
    {canCompose && <form className="fb-chat-composer" onSubmit={(event) => void send(event)}>
      <label htmlFor="chat-message" className="sr-only">Message</label>
      <textarea id="chat-message" ref={composer} value={draft} onChange={(event) => setDraft(event.target.value)}
        rows={1} maxLength={100000} disabled={busy} placeholder="Message" />
      <button type="submit" className="fb-chat-icon" aria-label="Send message" disabled={busy || !draft.trim()}><Send size={21} aria-hidden="true" /></button>
    </form>}
    <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === "end" ? "End connection?"
      : sheet === "delete" ? "Delete for me?" : sheet === "unsend" ? "Unsend message?"
        : sheet === "clear" ? "Clear chat for me?" : sheet === "message" ? "Message options" : "Conversation options"} height="medium">
      {sheet === "end" ? <div className="fb-chat-sheet">
        <p>Your messages stay here. Either of you can send a new request.</p>
        <div className="fb-chat-actions"><button type="button" disabled={busy} onClick={() => setSheet(null)}>Keep connection</button>
          <button type="button" disabled={busy || !current} onClick={() => void relationship("end")}>End connection</button></div>
      </div> : sheet === "delete" || sheet === "unsend" || sheet === "clear" ? <div className="fb-chat-sheet">
        <p>{sheet === "unsend" ? "Replace this message with ‘Message unsent’ for everyone. Messages already reported can still be reviewed."
          : sheet === "clear" ? "This clears your copy on your devices, not theirs." : "Remove this message from your devices, not the other person’s chat."}</p>
        <div className="fb-chat-actions"><button type="button" disabled={busy} onClick={() => setSheet(null)}>Cancel</button>
          <button type="button" disabled={busy || !current || (sheet !== "clear" && !selectedMessage)
            || (sheet === "clear" && (highest === 0 || outbox.length > 0))}
            onClick={() => void erase(sheet)}>{sheet === "unsend" ? "Unsend" : sheet === "clear" ? "Clear for me" : "Delete for me"}</button></div>
      </div> : sheet === "message" ? <div className="fb-chat-sheet">
        <button type="button" disabled={busy || !current || !selectedMessage} onClick={() => setSheet("delete")}>Delete for me</button>
        {selectedMessage?.authorId === accountId && selectedMessage.unsentAt === undefined &&
          <button type="button" disabled={busy || !current} onClick={() => setSheet("unsend")}>Unsend</button>}
        {selectedMessage?.authorId !== accountId && selectedMessage?.unsentAt === undefined &&
          <button type="button" disabled={busy || !current || !selectedMessage || !row}
            onClick={() => { setSheet(null); setReportOpen(true); }}>Report message</button>}
      </div> : <div className="fb-chat-sheet">
        <RetrySync accountId={accountId} />
        <Link to="/settings/privacy/messages">Message settings</Link>
        <button type="button" disabled={busy || !current} onClick={() => void relationship(view?.ownHidden ? "unhide" : "hide")}>{view?.ownHidden ? "Unhide conversation" : "Hide conversation"}</button>
        {view?.mode === "CONNECTED" && <button type="button" disabled={busy || !current} onClick={() => setSheet("end")}>End connection</button>}
        <button type="button" disabled={busy || !current || highest === 0 || outbox.length > 0} onClick={() => setSheet("clear")}>Clear chat for me</button>
        {outbox.length > 0 && <p className="fb-chat-secondary">Wait for messages still sending before clearing this chat.</p>}
        {row && <BlockControl userId={row.peerId} name={name || "this account"} blocked={current?.ownBlocked}
          onChanged={() => { void refreshMessaging(accountId).catch(() => undefined); }} />}
        {name && <Link to={`/u/${encodeURIComponent(name)}`}>View profile or report account</Link>}
        <Link to="/settings/privacy/blocked">Manage blocked accounts</Link>
      </div>}
    </BottomSheet>
    <ReportSheet open={reportOpen} target={selectedMessage && selectedMessage.unsentAt === undefined
      ? { targetType: "MESSAGE", targetId: selectedMessage.id, accountId, body: selectedMessage.body } : null}
      onClose={() => setReportOpen(false)} />
  </section>;
}
