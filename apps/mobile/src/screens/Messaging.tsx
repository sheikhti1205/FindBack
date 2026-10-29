import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Bell, ChevronDown, Ellipsis, ImagePlus, RefreshCw, Send } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../auth";
import { UserAvatar } from "../components/UserAvatar";
import { BottomSheet } from "../components/BottomSheet";
import { BlockControl } from "../components/BlockControl";
import { ReportSheet } from "../components/ReportSheet";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { announce } from "../components/LiveRegion";
import { fetchAccountLabels } from "../services/accountLabels";
import { useMessaging } from "../services/messaging/useMessaging";
import {
  changeMessagingRelationship, markMessagingConversationRead, readMessagingThreadState,
  refreshMessaging, sendMessagingText, sendMessagingMedia, clearMessagingConversation, removeMessagingMessage,
  fetchMessagingReceiptView, observeMessagingReceipt, readMessagingMedia, downloadMessagingMedia, recoverMessagingText,
  retryMessagingMessage,
} from "../services/messaging/runtime";
import type { MediaAttachment, OutboxEntry, StoredHumanMessage } from "../services/messaging/history";
import { prepareMessagingPhoto, type PreparedMessagingPhoto } from "../services/messaging/preparePhoto";
import type { MediaMetadata } from "../services/messaging/media";
import { PhotoUnavailableError } from "../services/messaging/mediaTransport";
import { chooseNativeImages, importNativeImageUri, importedImageToFile } from "../services/media/nativeMedia";
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

/** Compact heading; the complete name remains available to every user. */
export function ChatIdentity({ name, status }: { name?: string; status: string }) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const label = name ? `@${name}` : "Conversation";
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <>
    <div className="fb-chat-heading">
      <h1 ref={heading} tabIndex={-1}>{name
        ? <button type="button" className="fb-chat-identity" onClick={() => setOpen(true)}><span>{label}</span><ChevronDown size={16} aria-hidden="true" /></button>
        : <span className="fb-chat-identity"><span>{label}</span></span>}
      </h1>
      <p className="fb-chat-secondary">{status}</p>
    </div>
    {name && <BottomSheet open={open} onClose={() => setOpen(false)} title="Conversation participant" height="large">
      <p className="fb-chat-full-name">{label}</p>
    </BottomSheet>}
  </>;
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

function ChatPhoto({ accountId, conversationId, attachment, onOpen }: {
  accountId: string; conversationId: string; attachment: MediaAttachment;
  onOpen: (id: string, bytes: ArrayBuffer, mime: string) => void;
}) {
  const [content, setContent] = useState<{ url: string; bytes: ArrayBuffer } | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "failed" | "unavailable">("loading");
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const canDownload = attachment.expiresAt !== null && attachment.expiresAt !== undefined
    && attachment.expiresAt > Date.now()
    && (attachment.direction === "IN" || ["READY", "EVICTED", "AWAITING_ACK"].includes(attachment.state));
  useEffect(() => {
    let cancelled = false, url: string | null = null;
    setContent(null); setLoaded(false);
    if (attachment.state === "EVICTED") { setState(attachment.expiresAt !== null && attachment.expiresAt <= Date.now() ? "unavailable" : "missing"); return; }
    setState("loading");
    void readMessagingMedia(accountId, attachment.id).then((bytes) => {
      if (cancelled) return;
      if (!bytes) { setState("missing"); return; }
      const copy = bytes.slice(0);
      url = URL.createObjectURL(new Blob([copy], { type: attachment.mime }));
      setContent({ url, bytes: copy });
    }).catch(() => { if (!cancelled) setState("failed"); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [accountId, attachment.id, attachment.mime, attachment.state, attachment.expiresAt, version]);
  async function download() {
    setState("loading");
    try { await downloadMessagingMedia(accountId, conversationId, attachment.id); setVersion((v) => v + 1); }
    catch (error) { setState(error instanceof PhotoUnavailableError ? "unavailable" : "failed"); }
  }
  return <div className="fb-chat-photo" style={{ aspectRatio: `${attachment.width} / ${attachment.height}` }}>
    {content ? <button type="button" aria-label="View photo" onClick={() => onOpen(attachment.messageId, content.bytes, attachment.mime)}>
      <img src={content.url} alt="" onLoad={() => setLoaded(true)} onError={() => { setContent(null); setState("failed"); }}
        data-receipt-message={loaded && attachment.state === "READY" ? attachment.messageId : undefined} />
    </button> : <div role="status">{state === "loading" ? "Photo loading…" : state === "failed" ? "Could not load photo." : "Photo unavailable"}
      {canDownload && (state === "missing" || state === "failed") && <button type="button" onClick={() => void download()}>Download again</button>}
    </div>}
  </div>;
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
  const photoAllowed = view?.mode === "CONNECTED" && !view.ownBlocked && chat.accountId === accountId;
  const labels = useLabels(row ? [row.peerId] : []);
  const name = row ? labels.get(row.peerId) : undefined;
  const [messages, setMessages] = useState<StoredHumanMessage[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<{ source: File; prepared?: PreparedMessagingPhoto; error?: boolean } | null>(null);
  const [photoPreparing, setPhotoPreparing] = useState(false);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ id: string; previewUrl: string } | null>(null);
  const viewerUrls = useRef(new Set<string>());
  const photoController = useRef<AbortController | null>(null);
  const admission = useRef<{ metadata: MediaMetadata; caption: string } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"actions" | "end" | "message" | "delete" | "unsend" | "clear" | "review" | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [receipt, setReceipt] = useState<{ projections: typeof chat.currentProjections; readIds: Set<string> } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastMarked = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; photoController.current?.abort(); for (const url of viewerUrls.current) URL.revokeObjectURL(url); viewerUrls.current.clear(); };
  }, []);
  useEffect(() => {
    if (!photoAllowed || !photo?.prepared) { setDraftUrl(null); return; }
    const url = URL.createObjectURL(new Blob([photo.prepared.bytes.slice(0)], { type: photo.prepared.mime }));
    setDraftUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo?.prepared, photoAllowed]);
  useLayoutEffect(() => {
    if (!photoAllowed) {
      photoController.current?.abort(); setPhotoPreparing(false);
      setPhoto((previous) => previous && !previous.prepared ? { ...previous, error: true } : previous);
    }
  }, [photoAllowed]);
  const activeViewer = viewer && photoAllowed
    && messages.some((message) => message.id === viewer.id && message.unsentAt === undefined) ? viewer : null;
  useLayoutEffect(() => {
    if (viewer && !activeViewer) {
      if (viewerUrls.current.delete(viewer.previewUrl)) URL.revokeObjectURL(viewer.previewUrl);
      setViewer(null);
    }
  }, [viewer, activeViewer]);
  function openPhoto(id: string, bytes: ArrayBuffer, mime: string) {
    const previewUrl = URL.createObjectURL(new Blob([bytes.slice(0)], { type: mime }));
    viewerUrls.current.add(previewUrl); setViewer({ id, previewUrl });
  }
  function closePhoto() {
    if (!viewer) return;
    const url = viewer.previewUrl; setViewer(null);
    window.setTimeout(() => { if (viewerUrls.current.delete(url)) URL.revokeObjectURL(url); }, 350);
  }
  async function preparePhoto(source: File) {
    photoController.current?.abort();
    admission.current = null;
    const controller = new AbortController();
    photoController.current = controller;
    setPhoto({ source }); setPhotoPreparing(true);
    try {
      const prepared = await prepareMessagingPhoto(source, { signal: controller.signal });
      if (!controller.signal.aborted) setPhoto({ source, prepared });
    } catch {
      if (!controller.signal.aborted) setPhoto({ source, error: true });
    } finally { if (!controller.signal.aborted) setPhotoPreparing(false); }
  }
  async function choosePhoto() {
    if (Capacitor.getPlatform() !== "android") { photoInput.current?.click(); return; }
    photoController.current?.abort();
    const controller = new AbortController(); photoController.current = controller;
    try {
      const uris = await chooseNativeImages({ source: "photos", limit: 1 });
      if (controller.signal.aborted || !uris?.[0]) return;
      const imported = await importNativeImageUri(uris[0], { signal: controller.signal });
      if (!controller.signal.aborted) await preparePhoto(importedImageToFile(imported));
    } catch { if (!controller.signal.aborted) setError("Could not open that photo. Please try again."); }
  }
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
      setMessages(state.messages); setOutbox(state.outbox); setMedia(state.media); setLoaded(true);
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
    if (!area || !loaded || !visible || sheet !== null || reportOpen || viewer || chat.accountId !== accountId || chat.status !== "ready"
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
      const candidates = messages.filter((message) => message.server && message.unsentAt === undefined && message.messageType);
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
    // A loaded READY photo becomes eligible without waiting for another scroll.
    // Capture non-bubbling image loads; the next frame sees React's loaded DOM.
    area.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      controller.abort();
      if (frame) window.cancelAnimationFrame(frame);
      area.removeEventListener("scroll", schedule);
      area.removeEventListener("load", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [accountId, conversationId, chat.accountId, chat.status, chat.currentProjections, current, loaded, messages, visible, sheet, reportOpen, viewer]);

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
    if (!row || busy || (!photo && !draft.trim())) return;
    if (photo && (!photo.prepared || view?.mode !== "CONNECTED" || view.ownBlocked)) return;
    setBusy(true); setError(null);
    try {
      if (photo?.prepared) {
        const { bytes, ...info } = photo.prepared;
        const attempt = admission.current ?? { caption: draft, metadata: { ...info, id: crypto.randomUUID(), messageId: crypto.randomUUID(), direction: "OUT", expiresAt: null } };
        admission.current = attempt;
        await sendMessagingMedia(accountId, conversationId, row.peerId, attempt.caption, attempt.metadata, bytes);
      } else await sendMessagingText(accountId, conversationId, row.peerId, draft);
      if (alive.current) { nearBottom.current = true; setDraft(""); setPhoto(null); admission.current = null; announce("Message saved. Sending."); }
    } catch { if (alive.current) setError("Your message could not be saved. Your draft is still here."); }
    finally { if (alive.current) { setBusy(false); composer.current?.focus(); } }
  }
  const selectedMessage = messages.find((message) => message.id === selectedMessageId);
  const selectedNeedsReview = selectedMessage?.authorId === accountId && !selectedMessage.server
    && selectedMessage.unsentAt === undefined
    && outbox.some((entry) => entry.messageId === selectedMessageId && entry.status === "NEEDS_REVIEW");
  async function reviewMessage(action: "send" | "delete") {
    if (busy || !selectedNeedsReview || !selectedMessage) return;
    setBusy(true); setError(null);
    try {
      if (action === "send") await recoverMessagingText(accountId, conversationId, selectedMessage.id);
      else await removeMessagingMessage(accountId, conversationId, selectedMessage.id, false);
      if (alive.current) { setSheet(null); setSelectedMessageId(null); announce(action === "send" ? "Text saved. Sending." : "Your copy was removed."); }
    } catch { if (alive.current) setError("Could not confirm this change. Sync and check your chat before trying again."); }
    finally { if (alive.current) setBusy(false); }
  }
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
      <ChatIdentity name={name} status={!current ? "Saved chat" : current.mode === "CONNECTED" ? "Connected" : "Message request"} />
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
          const attachment = media.find((entry) => entry.messageId === message.id);
          return <li key={message.id} className={own ? "fb-chat-line fb-chat-line-own" : "fb-chat-line"}>
            <div data-receipt-message={message.messageType === "TEXT" && message.body && message.unsentAt === undefined ? message.id : undefined} className={own ? "fb-chat-message fb-chat-message-own" : "fb-chat-message"}>
            <span className="sr-only">{own ? "You: " : `${name ? `@${name}` : "Member"}: `}</span>
            {message.unsentAt !== undefined ? <p>Message unsent</p> : <>
            {message.messageType === "MEDIA" && attachment && view?.mode === "CONNECTED" && !view.ownBlocked && <ChatPhoto key={attachment.id} accountId={accountId} conversationId={conversationId} attachment={attachment} onOpen={openPhoto} />}
            {message.body ? <p dir="auto">{message.body}</p> : !attachment && <p>{message.messageType === "MEDIA" ? "Photo loading…" : "Message unavailable"}</p>}
            {own && <span className="fb-chat-message-status">{pending?.status === "NEEDS_REVIEW" ? "Needs review — " : message.messageType === "MEDIA" && !attachment ? "Photo pending" : attachment && !["READY", "EVICTED"].includes(attachment.state) ? (attachment.state === "FAILED" ? "Failed — " : "Sending…") : message.server ? (visible && chat.status === "ready" && current?.mode === "CONNECTED" && !current.ownBlocked
              && message.unsentAt === undefined && receipt?.projections === chat.currentProjections && receipt.readIds.has(message.id) ? "Read" : "Sent") : pending?.status === "FAILED" ? "Failed — " : "Sending…"}
              {(attachment?.state === "FAILED" || (!message.server && pending?.status === "FAILED")) && pending?.status !== "NEEDS_REVIEW" && <button type="button" onClick={() => {
              // A refused send keeps its original boundary; re-flushing it can only
              // fail again. The message-level retry rebinds that boundary because a
              // human asked for it, then flushes. A failed upload on an already
              // accepted message has no boundary to move.
              const retry = !message.server && pending?.status === "FAILED"
                ? retryMessagingMessage(accountId, conversationId, message.id)
                : refreshMessaging(accountId);
              void retry.catch(() => setError("Could not retry. Try syncing again."));
            }}>Retry</button>}</span>}
            {own && pending?.status === "NEEDS_REVIEW" && <button type="button" disabled={busy} onClick={() => { setSelectedMessageId(message.id); setSheet("review"); }}>Review message</button>}
            {own && attachment && !message.server && <button type="button" aria-label="Remove pending photo" onClick={() => {
              void removeMessagingMessage(accountId, conversationId, message.id, false).catch(() => {
                setError("Could not confirm this change. Sync and check your chat.");
                void refreshMessaging(accountId).catch(() => undefined);
              });
            }}>Remove</button>}
            </>}
            </div>
            {message.server && <button type="button" className="fb-chat-icon fb-chat-message-options" aria-label={own ? "Options for your message" : "Options for received message"}
              onClick={() => { setSelectedMessageId(message.id); setSheet("message"); }}><Ellipsis size={16} aria-hidden="true" /></button>}
          </li>;
        })}
      </ol>
      {view?.ownBlocked && <p className="fb-chat-secondary">You’ve blocked this account. Manage blocked accounts in Privacy settings.</p>}
    </div>
    {error && <p className="fb-chat-error" role="alert">{error}</p>}
    {photo && <div className="fb-chat-photo-draft" role="status">
      {photoAllowed && draftUrl && photo.prepared && <img src={draftUrl} alt="Selected photo" style={{ aspectRatio: `${photo.prepared.width} / ${photo.prepared.height}` }} />}
      {!photoAllowed ? "Photos are available when connected. Remove this photo to send text only." : photoPreparing ? "Preparing photo…" : photo.error ? "Could not prepare photo." : "Photo ready"}
      {photoAllowed && photo.error && <button type="button" onClick={() => void preparePhoto(photo.source)}>Retry</button>}
      <button type="button" aria-label="Remove photo" disabled={busy || !!admission.current} onClick={() => { photoController.current?.abort(); admission.current = null; setPhoto(null); setPhotoPreparing(false); }}>Remove</button>
    </div>}
    {canCompose && <form className="fb-chat-composer" onSubmit={(event) => void send(event)}>
      {view?.mode === "CONNECTED" && <>
        <input ref={photoInput} type="file" accept="image/*" aria-label="Choose photo" hidden onChange={(event) => {
          const source = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (source && Capacitor.getPlatform() !== "android") void preparePhoto(source);
        }} />
        <button type="button" className="fb-chat-icon" aria-label="Attach photo" disabled={busy || !!admission.current} onClick={() => void choosePhoto()}><ImagePlus size={21} aria-hidden="true" /></button>
      </>}
      <label htmlFor="chat-message" className="sr-only">Message</label>
      <textarea id="chat-message" ref={composer} value={draft} onChange={(event) => setDraft(event.target.value)}
        rows={1} maxLength={100000} disabled={busy || !!admission.current} placeholder="Message" />
      <button type="submit" className="fb-chat-icon" aria-label="Send message" disabled={busy || (photo ? !photoAllowed || !photo.prepared : !draft.trim())}><Send size={21} aria-hidden="true" /></button>
    </form>}
    <PhotoLightbox photo={activeViewer} onClose={closePhoto} />
    <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === "end" ? "End connection?"
      : sheet === "delete" ? "Delete for me?" : sheet === "unsend" ? "Unsend message?"
        : sheet === "clear" ? "Clear chat for me?" : sheet === "review" ? "Review message" : sheet === "message" ? "Message options" : "Conversation options"} height="medium">
      {sheet === "review" ? <div className="fb-chat-sheet">
        <p>We couldn’t confirm this older message. Send the text shown here only, or remove your copy. This won’t recall anything already delivered.</p>
        <p className="fb-chat-review-copy" dir="auto">{selectedMessage?.body || "No saved text. To send a photo, attach it again as a new message."}</p>
        <div className="fb-chat-actions">
          <button type="button" disabled={busy || !selectedNeedsReview || !selectedMessage?.body.trim() || !canCompose} onClick={() => void reviewMessage("send")}>Send text only</button>
          <button type="button" disabled={busy || !selectedNeedsReview} onClick={() => void reviewMessage("delete")}>Delete for me</button>
        </div>
      </div> : sheet === "end" ? <div className="fb-chat-sheet">
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
