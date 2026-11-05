import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { Archive, ArrowLeft, BellOff, Ellipsis, Flag, Images, Info, ListFilter, LogOut, MapPin, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings2, ShieldBan, Trash2, UserRound } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import type { PostItem } from "@norfold/shared";
import { copyStaticLocation, isUuid } from "../services/messaging/validation";
import { subscribeSafetyChanged } from "../services/safetySignals";
import { onRealtime } from "../services/realtime";
import { useAuth } from "../auth";
import { UserAvatar } from "../components/UserAvatar";
import { ChatIdentity } from "../components/ChatIdentity";
import { StatusChip } from "../components/StatusChip";
import { formatEventDate, timeAgo } from "../utils/dates";
import { SplitView, type SplitPaneState } from "../components/SplitView";
import { CHAT_PANE } from "../components/panePreference";
import { ActionMenu } from "../components/ActionMenu";
import { PeopleSearch } from "../components/PeopleSearch";
import { PeerChatComposer } from "../components/PeerChatComposer";
import { ChatLocationComposer } from "../components/ChatLocationComposer";
import { AdaptiveTaskSurface, ConfirmDialog } from "../components/AdaptiveTaskSurface";
import { BlockControl } from "../components/BlockControl";
import { ReportSheet } from "../components/ReportSheet";
import { MediaViewer, type MediaViewerItem } from "../components/MediaViewer";
import { useMediaUrl } from "../services/media/privateMedia";
import { announce } from "../components/LiveRegion";
import { PreferenceSwitchRow } from "../components/settings/SettingsPrimitives";
import { fetchAccountLabels } from "../services/accountLabels";
import { fetchPost } from "../services/posts";
import { useMessaging } from "../services/messaging/useMessaging";
import { BackupPrompt } from "../components/BackupPrompt";
import {
  changeMessagingRelationship, markMessagingConversationRead, readMessagingThreadState,
  refreshMessaging, sendMessagingText, sendMessagingLocation, sendMessagingMedia, clearMessagingConversation, removeMessagingMessage,
  fetchMessagingReceiptView, observeMessagingReceipt, readMessagingMedia, downloadMessagingMedia, recoverMessagingText,
  retryMessagingMessage, setMessagingMuted, watchMessagingThread,
} from "../services/messaging/runtime";
import type { MediaAttachment, OutboxEntry, StaticLocation, StoredHumanMessage } from "../services/messaging/history";
import { prepareMessagingPhoto, type PreparedMessagingPhoto } from "../services/messaging/preparePhoto";
import type { MediaMetadata } from "../services/messaging/media";
import { PhotoUnavailableError } from "../services/messaging/mediaTransport";
import { chooseNativeImages, importNativeImageUri, importedImageToFile } from "../services/media/nativeMedia";
import "./Messaging.css";

/** Live report subject for a report-linked message. Only the id travels with the
 * message; readability is resolved here, so a later-hidden report reads
 * "Report unavailable" instead of showing a stale private snapshot. */
export function ChatReportContext({ reportId, preview = false, safetyKey = "" }: {
  reportId: string;
  preview?: boolean;
  /**
   * The caller's current relationship/concealment state for this conversation.
   * A block in this tab must revoke a loaded preview, not wait for a focus
   * event, so a changed key starts a fresh session instead of keeping a
   * snapshot that was read under the previous authority.
   */
  safetyKey?: string;
}) {
  return <ReportContextSession key={`${reportId}:${safetyKey}`} reportId={reportId} preview={preview} />;
}

function ReportContextSession({ reportId, preview }: { reportId: string; preview: boolean }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "unavailable"; post?: PostItem }>({ status: "loading" });
  useEffect(() => {
    let generation = 0, cancelled = false;
    const refresh = () => {
      const request = ++generation;
      setState({ status: "loading" });
      void fetchPost(reportId).then((post) => {
        if (cancelled || request !== generation) return;
        // fetchPost is not exclusion-only: it can return a public row the reader
        // has blocked and leave concealment to presentation. A chat preview has
        // no shield, so a blocked report is unavailable here — never a title,
        // photo or place.
        setState(post.blockedAuthor === true ? { status: "unavailable" } : { status: "ready", post });
      }).catch(() => { if (!cancelled && request === generation) setState({ status: "unavailable" }); });
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    // A block made in this tab (the quick card, a profile) must revoke what is
    // already on screen even when the peer's own projection is unrelated: the
    // subject here may be a third person's report.
    const unsubscribe = subscribeSafetyChanged(refresh);
    // The canonical feed channel already carries every report UPDATE/DELETE,
    // including moderation. Do not open one private room per history preview
    // (rooms are shared with detail); invalidate only this report's subject.
    const offPost = onRealtime("feed:changed", payload => {
      if (payload.postId === reportId) refresh();
    });
    refresh(); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true; unsubscribe(); offPost();
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reportId]);
  const firstImageUrl =
    state.status === "ready"
      ? state.post?.attachments?.find((attachment) => attachment.mimeType.startsWith("image/"))?.fileUrl
      : undefined;
  const firstImageSrc = useMediaUrl(firstImageUrl);
  if (preview && state.status !== "ready") return <span className="fb-chat-row-context">{state.status === "loading" ? "Loading report…" : "Report unavailable"}</span>;
  if (state.status === "loading") return <p className="fb-chat-context fb-chat-secondary">Loading report…</p>;
  if (state.status === "unavailable") return <p className="fb-chat-context fb-chat-secondary" data-chat-report="unavailable">
    Report unavailable</p>;
  const post = state.post!;
  if (preview) return <span className="fb-chat-row-context" dir="auto">{post.type === "LOST" ? "Lost" : "Found"} report · {post.title}</span>;
  return <Link className="fb-chat-context fb-chat-report-card" to={`/posts/${encodeURIComponent(reportId)}`} data-chat-report={reportId}>
    {firstImageSrc && <img src={firstImageSrc} alt={post.title} loading="lazy" />}
    <span className="fb-chat-report-copy">
      <span className="fb-chat-secondary">{post.type === "LOST" ? "Lost" : "Found"} report</span>
      <strong dir="auto">{post.title}</strong>
      {post.locationLabel && <span className="fb-chat-secondary" dir="auto">{post.locationLabel}</span>}
      <span className="fb-chat-report-meta"><StatusChip post={post} />
        {post.eventDate && <time dateTime={post.eventDate}>{formatEventDate(post.eventDate)}</time>}
      </span>
    </span>
  </Link>;
}

/** One static coordinate set the sender chose to share. No live position. */
export function ChatLocation({ location }: { location: StaticLocation }) {
  const lat = location.lat.toFixed(5), lng = location.lng.toFixed(5);
  return <div className="fb-chat-location" data-chat-location>
    <MapPin size={17} aria-hidden="true" />
    <div>
      <p>Location shared</p>
      <p className="fb-chat-secondary">{lat}, {lng}{location.accuracy !== null ? ` · device estimate ${Math.max(1, Math.round(location.accuracy))} m` : ""}</p>
    </div>
    <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`}
      target="_blank" rel="noreferrer noopener">Open map</a>
  </div>;
}

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

/** Own module so the visual fixture route can render it without the runtime. */
export { ChatIdentity } from "../components/ChatIdentity";

// A media task is another view of ChatPhoto, not another ready-byte cache.
function ignorePhotoReadiness() {}

function RetrySync({ accountId, labelled = false }: { accountId: string; labelled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <>
    <button className={labelled ? "fb-chat-info-row" : "fb-chat-icon"} type="button" aria-label={labelled ? undefined : "Sync messages"} disabled={busy}
      onClick={() => {
        setBusy(true); setError(false);
        void refreshMessaging(accountId).catch(() => setError(true)).finally(() => setBusy(false));
      }}><RefreshCw size={19} aria-hidden="true" className={busy ? "fb-chat-refreshing" : ""} />{labelled && <span>Sync messages</span>}</button>
    {error && <span role="status" className="fb-chat-secondary">Could not sync.</span>}
  </>;
}

function ChatPhoto({ accountId, conversationId, attachment, onOpen, onReady }: {
  accountId: string; conversationId: string; attachment: MediaAttachment;
  onOpen: (id: string, bytes: ArrayBuffer, mime: string) => void;
  onReady: (id: string, content: { bytes: ArrayBuffer; mime: string } | null) => void;
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
    onReady(attachment.id, null);
    if (attachment.state === "EVICTED") { setState(attachment.expiresAt !== null && attachment.expiresAt <= Date.now() ? "unavailable" : "missing"); return; }
    setState("loading");
    void readMessagingMedia(accountId, attachment.id).then((bytes) => {
      if (cancelled) return;
      if (!bytes) { setState("missing"); return; }
      const copy = bytes.slice(0);
      url = URL.createObjectURL(new Blob([copy], { type: attachment.mime }));
      setContent({ url, bytes: copy });
      onReady(attachment.id, { bytes: copy, mime: attachment.mime });
    }).catch(() => { if (!cancelled) setState("failed"); });
    return () => { cancelled = true; onReady(attachment.id, null); if (url) URL.revokeObjectURL(url); };
  }, [accountId, attachment.id, attachment.mime, attachment.state, attachment.expiresAt, version, onReady]);
  async function download() {
    setState("loading");
    try { await downloadMessagingMedia(accountId, conversationId, attachment.id); setVersion((v) => v + 1); }
    catch (error) { setState(error instanceof PhotoUnavailableError ? "unavailable" : "failed"); }
  }
  return <div className="fb-chat-photo" style={{ aspectRatio: `${attachment.width} / ${attachment.height}` }}>
    {content ? <button type="button" aria-label="View photo" onClick={() => onOpen(attachment.messageId, content.bytes, attachment.mime)}>
      <img src={content.url} alt="" onLoad={() => setLoaded(true)} onError={() => { onReady(attachment.id, null); setContent(null); setState("failed"); }}
        data-receipt-message={loaded && attachment.state === "READY" ? attachment.messageId : undefined} />
    </button> : <div role="status">{state === "loading" ? "Photo loading…" : state === "failed" ? "Could not load photo." : "Photo unavailable"}
      {canDownload && (state === "missing" || state === "failed") && <button type="button" onClick={() => void download()}>Download again</button>}
    </div>}
  </div>;
}

export function Connections() {
  const { user } = useAuth();
  const { conversationId } = useParams();
  return user ? <SplitView selected={!!conversationId}
    pane={{ ...CHAT_PANE, label: "Resize conversation list" }}
    list={(pane) => <ConnectionsSession key={user.id} accountId={user.id} selectedId={conversationId} pane={pane} />}
    detail={conversationId ? <Outlet /> : <div className="fb-chat-empty"><h2>Choose a conversation</h2><p>Open a chat, or search for someone to connect with.</p></div>} /> : null;
}

/** Replace, rather than stack a duplicate legacy screen in navigation history. */
export function LegacyChatsRedirect() {
  const { conversationId } = useParams();
  const location = useLocation();
  return <Navigate replace to={{ pathname: conversationId ? `/chats/${encodeURIComponent(conversationId)}` : "/chats", search: location.search, hash: location.hash }} />;
}

/** Collapsed conversation pane: the same people as a labelled avatar rail.
 *
 * Extracted so the rail can be rendered without the messaging runtime. Names and
 * previews leave the rail; the count survives in the link's accessible name,
 * and the expand control is the only chrome it needs. */
export function ChatRail({ rows, labels, selectedId, onExpand, headingRef, toggleRef }: {
  rows: { conversationId: string; peerId: string; unreadCount: number }[];
  labels: Map<string, string>;
  selectedId?: string;
  onExpand: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  toggleRef?: RefObject<HTMLButtonElement | null>;
}) {
  return <section className="fb-chat-page fb-chat-rail" aria-label="Chats">
    <header className="fb-chat-header fb-chat-rail-header">
      <h1 ref={headingRef} tabIndex={-1} className="sr-only">Chats</h1>
      <button ref={toggleRef} type="button" className="fb-chat-icon" aria-label="Expand conversation list" onClick={onExpand}>
        <PanelLeftOpen size={20} aria-hidden="true" />
      </button>
    </header>
    <ul className="fb-chat-rail-list">
      {rows.map((row) => {
        const name = labels.get(row.peerId);
        const unread = row.unreadCount;
        return <li key={row.conversationId}>
          <Link to={`/chats/${row.conversationId}`} className="fb-chat-rail-row"
            aria-current={selectedId === row.conversationId ? "page" : undefined}
            aria-label={`${name ? `@${name}` : "Conversation"}${unread > 0 ? `, ${unread} unread` : ""}`}
            title={name ? `@${name}` : "Member"}>
            <UserAvatar username={name} size={40} />
            {unread > 0 && <span className="fb-chat-rail-unread" aria-hidden="true" />}
          </Link>
        </li>;
      })}
    </ul>
  </section>;
}

function ConnectionsSession({ accountId, selectedId, pane }: {
  accountId: string; selectedId?: string; pane?: SplitPaneState;
}) {
  const chat = useMessaging();
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const paneToggle = useRef<HTMLButtonElement>(null);
  const paneSettled = useRef(false);
  const labels = useLabels(chat.conversations.map((row) => row.peerId));
  useEffect(() => { heading.current?.focus(); }, []);
  // Collapsing swaps the header control for the rail's expand button; keep the
  // keyboard where the user was rather than dropping focus to the document.
  useEffect(() => {
    if (!paneSettled.current) { paneSettled.current = true; return; }
    paneToggle.current?.focus({ preventScroll: true });
  }, [pane?.collapsed]);
  // One backup ticker per open Chat surface; it stops when the last one closes.
  const requests = chat.conversations.filter(row => {
    const view = chat.currentProjections?.[row.conversationId] ?? row.cachedProjection;
    return !view?.ownHidden && !view?.ownDeclined && view?.mode === "REQUEST" && view.request === "INCOMING";
  }).length;
  const normalized = query.trim().replace(/^@/, "").toLowerCase();
  const rows = chat.conversations.filter((row) => {
    const view = chat.currentProjections?.[row.conversationId] ?? row.cachedProjection;
    const dismissed = view?.ownHidden || view?.ownDeclined;
    if (normalized && !`${labels.get(row.peerId) ?? ""} ${row.lastMessage?.unsentAt === undefined ? row.lastMessage?.body ?? "" : ""}`.toLowerCase().includes(normalized)) return false;
    if (filter === "Archived") return dismissed;
    if (dismissed) return false;
    if (filter === "Requests") return view?.mode === "REQUEST" && view.request === "INCOMING";
    if (filter === "Unread") return row.unreadCount > 0;
    return true;
  });
  // A collapsed pane is a rail of the same people, not a second list: names and
  // previews leave, each avatar stays a labelled link and the unread marker
  // survives as a dot with the count in the link's name.
  if (pane?.wide && pane.collapsed) return <ChatRail rows={rows} labels={labels} selectedId={selectedId}
    onExpand={pane.toggle} headingRef={heading} toggleRef={paneToggle} />;
  return <section className="fb-chat-page" aria-label="Chats">
    <header className="fb-chat-header">
      <h1 ref={heading} tabIndex={-1} className="fb-chat-list-title">Chats</h1>
      <RetrySync accountId={accountId} />
      {pane?.wide && <button ref={paneToggle} type="button" className="fb-chat-icon" aria-label="Collapse conversation list" onClick={pane.toggle}>
        <PanelLeftClose size={20} aria-hidden="true" />
      </button>}
      <ActionMenu label="Filter chats" icon={<ListFilter size={20} aria-hidden="true" />} items={["All", "Unread", "Archived"].map(value => ({ id: value, label: value, onAction: () => setFilter(value) }))} />
    </header>
    <label className="fb-chat-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Search people or chats" placeholder="Search people or chats" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <BackupPrompt sequences={chat.conversations.reduce((total, row) => total + row.lastSequence, 0)} />
    <div className="fb-chat-filters" role="group" aria-label="Show conversations">
      {["All", "Requests"].map((value) => <button key={value} type="button" aria-label={value === "Requests" ? `Requests, ${requests}` : "All"}
        aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}{value === "Requests" && requests > 0 && <span className="fb-chat-count" aria-hidden="true">{requests}</span>}</button>)}
      {["Unread", "Archived"].includes(filter) && <span className="fb-chat-active-filter">{filter}</span>}
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
          const state = view?.ownBlocked ? "Blocked by you" : view?.ownHidden ? (view.mode === "CONNECTED" ? "Archived" : "Hidden request")
            : view?.ownDeclined ? "Dismissed" : view?.mode === "CONNECTED" ? "Connected"
              : view?.request === "INCOMING" ? "Message request" : view?.request === "OUTGOING" ? "Request sent" : "Conversation";
          return <li key={row.conversationId}>
             <Link to={`/chats/${row.conversationId}`} className="fb-chat-row" aria-current={selectedId === row.conversationId ? "page" : undefined}>
              <UserAvatar username={name} size={44} />
              <span className="fb-chat-row-copy"><strong>{name ? `@${name}` : "Member"}</strong>
                <span className="fb-chat-preview">{row.lastMessage?.unsentAt !== undefined ? "Message unsent"
                  : row.lastMessage?.body || (row.lastMessage?.messageType === "LOCATION" ? "Location shared" : row.lastMessage?.messageType === "MEDIA" ? "Photo" : state)}</span>
                {row.lastMessage?.contextReportId && row.lastMessage.unsentAt === undefined && <ChatReportContext reportId={row.lastMessage.contextReportId} safetyKey={view?.ownBlocked ? "blocked" : "clear"} preview />}
                {row.lastMessage && <span className="fb-chat-secondary">{state}{!chat.currentProjections ? " · Saved chat" : ""}</span>}
              </span>
               <span className="fb-chat-row-meta">
                 {row.updatedAt > 0 && <time dateTime={new Date(row.updatedAt).toISOString()}
                   title="Chat updated on this device">{timeAgo(new Date(row.updatedAt).toISOString())}</time>}
                 {row.unreadCount > 0 && <span className="fb-chat-unread" aria-label={`${row.unreadCount} unread messages`}>{row.unreadCount}</span>}
               </span>
            </Link>
          </li>;
        })}
       </ul>
       {normalized && <><h2 className="fb-chat-people-heading">People</h2><PeopleSearch query={query} /></>}
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
  const [renderedRevision, setRenderedRevision] = useState(-1);
  const [threadReadFailed, setThreadReadFailed] = useState(false);
  const [threadReadRetry, setThreadReadRetry] = useState(0);
  const runtimeOpen = chat.accountId === accountId && (chat.status === "ready" || chat.status === "offline");
  useEffect(() => {
    if (runtimeOpen) return watchMessagingThread(accountId, conversationId);
  }, [runtimeOpen, accountId, conversationId]);
  const threadSync = chat.threadSync?.conversationId === conversationId ? chat.threadSync : null;
  const threadBlocked = threadReadFailed || !threadSync || (threadSync.mode !== "ready" && threadSync.mode !== "soft")
    || (threadSync.appliedRevision !== undefined && renderedRevision < threadSync.appliedRevision);
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
  const draftRevision = useRef(0);
  // A report-linked entry carries the subject once; the first send consumes it so
  // a later ordinary message is never silently tagged with the same report.
  const route = useLocation();
  const navigate = useNavigate();
  const routeRef = useRef(route); routeRef.current = route;
  const queryReport = new URLSearchParams(route.search).get("report");
  const validReport = isUuid(queryReport) ? queryReport : null;
  const [reportContext, setReportContext] = useState(validReport);
  useEffect(() => { setReportContext(validReport); }, [validReport]);
  function clearReportContext(expected: string | null) {
    const latest = routeRef.current, params = new URLSearchParams(latest.search);
    if (expected !== params.get("report")) return;
    params.delete("report"); setReportContext(null);
    navigate({ pathname: latest.pathname, search: params.toString() ? `?${params}` : "", hash: latest.hash },
      { replace: true, state: latest.state });
  }
  const locationAllowed = !threadBlocked && chat.accountId === accountId && chat.status === "ready"
    && current?.mode === "CONNECTED" && !current.ownBlocked;
  const locationAuthority = useRef("");
  locationAuthority.current = JSON.stringify([chat.accountId, chat.status, row?.peerId,
    current?.mode, current?.ownBlocked, current?.revision]);
  const [photo, setPhoto] = useState<{ source: File; prepared?: PreparedMessagingPhoto; error?: boolean } | null>(null);
  const [photoPreparing, setPhotoPreparing] = useState(false);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ id: string; items: MediaViewerItem[] } | null>(null);
  const readyPhotos = useRef(new Map<string, { bytes: ArrayBuffer; mime: string }>());
  const rememberPhoto = useCallback((id: string, content: { bytes: ArrayBuffer; mime: string } | null) => {
    if (content) readyPhotos.current.set(id, content); else readyPhotos.current.delete(id);
  }, []);
  const viewerUrls = useRef(new Set<string>());
  const photoController = useRef<AbortController | null>(null);
  const admission = useRef<{ metadata: MediaMetadata; caption: string } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"actions" | "search" | "media" | "location" | "end" | "message" | "delete" | "unsend" | "clear" | "review" | null>(null);
  useLayoutEffect(() => {
    if (threadBlocked) { setSheet(null); setViewer(null); }
  }, [threadBlocked]);
  useLayoutEffect(() => { if (!locationAllowed) setSheet(previous => previous === "location" ? null : previous); }, [locationAllowed]);
  const [messageQuery, setMessageQuery] = useState("");
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<"account" | "message" | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  // Projection object identity changes on harmless refresh. Receipt knowledge is
  // monotonic only within this semantic authority AND the server receipt context.
  const receiptAuthority = current ? JSON.stringify([accountId, conversationId, current.peerId,
    current.epoch, current.mode, current.requestEpoch, current.ownBlocked]) : null;
  const [receipt, setReceipt] = useState<{ authority: string; context: string; readIds: Set<string> } | null>(null);
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
  const viewerItems = photoAllowed ? viewer?.items.filter((item) => messages.some((message) => message.id === item.id && message.unsentAt === undefined)
    && media.some((attachment) => attachment.messageId === item.id)) ?? [] : [];
  const activeViewer = viewer && viewerItems.some((item) => item.id === viewer.id) ? viewer : null;
  useLayoutEffect(() => {
    if (viewer) {
      const retained = new Set(activeViewer ? viewerItems.map((item) => item.src) : []);
      for (const url of viewerUrls.current) if (!retained.has(url)) { URL.revokeObjectURL(url); viewerUrls.current.delete(url); }
      if (!activeViewer) setViewer(null);
    }
  }, [viewer, activeViewer, viewerItems]);
  function openPhoto(id: string, bytes: ArrayBuffer, mime: string) {
    if (!photoAllowed) return;
    const items = messages.filter((message) => message.unsentAt === undefined).flatMap((message) => {
      const attachment = media.find((item) => item.messageId === message.id);
      const content = attachment ? readyPhotos.current.get(attachment.id) : undefined;
      const available = content ?? (message.id === id ? { bytes, mime } : undefined);
      if (!attachment || !available) return [];
      const src = URL.createObjectURL(new Blob([available.bytes.slice(0)], { type: available.mime }));
      viewerUrls.current.add(src);
      return [{ id: message.id, src, width: attachment.width, height: attachment.height, alt: "Conversation photo" }];
    });
    setViewer({ id, items });
  }
  function closePhoto() {
    setViewer(null);
    for (const url of viewerUrls.current) URL.revokeObjectURL(url);
    viewerUrls.current.clear();
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
      setRenderedRevision(chat.revision); setThreadReadFailed(false);
    }).catch(() => { if (!cancelled) setThreadReadFailed(true); });
    return () => { cancelled = true; };
  }, [accountId, conversationId, chat.accountId, chat.status, chat.revision, threadReadRetry]);
  useLayoutEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (sheet || !jumpTo) return;
    const frame = requestAnimationFrame(() => {
      const target = Array.from(scroll.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? [])
        .find(element => element.dataset.chatMessage === jumpTo);
      target?.scrollIntoView?.({ block: "center" });
      target?.focus({ preventScroll: true });
      setJumpTo(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [sheet, jumpTo]);
  const highest = messages.reduce((maximum, message) => Math.max(maximum, message.server?.sequence ?? 0), 0);
  useEffect(() => {
    const area = scroll.current;
    if (!area || !loaded || threadBlocked) return;
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
  }, [accountId, conversationId, highest, loaded, threadBlocked]);

  // This is live, disposable receipt authority, never the stored unread cursor.
  // A fetched context precedes a fresh geometric observation of an inbound bubble.
  useLayoutEffect(() => {
    const area = scroll.current;
    const projections = chat.currentProjections;
    if (chat.accountId !== accountId || (current && (current.mode !== "CONNECTED" || current.ownBlocked))) {
      setReceipt(null);
    } else if (receiptAuthority) {
      setReceipt(previous => previous?.authority === receiptAuthority ? previous : null);
    }
    if (threadBlocked || !area || !loaded || !visible || sheet !== null || reportTarget || viewer || chat.accountId !== accountId || chat.status !== "ready"
      || !projections || !receiptAuthority || current?.mode !== "CONNECTED" || current.ownBlocked) return;
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
              if (context !== batchContext) { context = null; lastObserved = null; }
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
          setReceipt(previous => batchContext === null ? null : {
            authority: receiptAuthority, context: batchContext!,
            readIds: new Set([...(previous?.authority === receiptAuthority && previous.context === batchContext ? previous.readIds : []), ...readIds]),
          });
          checkVisible();
          if (ticket !== version) continue;
          return;
        }
      } catch {
        // A failed lookup is not evidence that the peer unread a message. It
        // cannot authorize observation, but does not erase same-context knowledge.
        if (!controller.signal.aborted) { context = null; lastObserved = null; requestedKey = null; }
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
  }, [accountId, conversationId, chat.accountId, chat.status, chat.currentProjections, current, receiptAuthority, loaded, messages, visible, sheet, reportTarget, viewer, threadBlocked]);

  async function setMuted(muted: boolean) {
    if (busy || chat.status !== "ready" || typeof current?.ownMuted !== "boolean") return;
    setBusy(true); setError(null);
    try {
      await setMessagingMuted(accountId, conversationId, muted);
    } catch { if (alive.current) setError("Your notifications change could not be saved. Sync and try again."); }
    finally { if (alive.current) setBusy(false); }
  }
  async function relationship(action: "accept" | "end" | "hide" | "unhide" | "decline") {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await changeMessagingRelationship(accountId, conversationId, action);
      if (alive.current) { setSheet(null); announce("Conversation refreshed."); }
    } catch { if (alive.current) setError("That change could not be saved. Try again."); }
    finally { if (alive.current) setBusy(false); }
  }
  /** One explicit, user-initiated static share. Never tracked, never automatic,
   * and never available before the connection exists. */
  async function shareLocation(location: StaticLocation) {
    if (!row || !locationAllowed || !alive.current) throw new Error("Conversation unavailable");
    await sendMessagingLocation(accountId, conversationId, row.peerId, copyStaticLocation(location));
    if (alive.current) nearBottom.current = true;
  }
  /**
   * Normal conversation is not a form submission: the durable outbox admits the
   * message, the draft clears, and the next message can start immediately. Only
   * authority/destructive actions take `busy`.
   */
  async function send() {
    if (threadBlocked || !row || (!photo && !draft.trim())) return;
    if (photo && (!photo.prepared || view?.mode !== "CONNECTED" || view.ownBlocked)) return;
    const body = draft, sendingPhoto = photo, sendingRevision = draftRevision.current;
    setError(null);
    try {
      if (sendingPhoto?.prepared) {
        const { bytes, ...info } = sendingPhoto.prepared;
        const attempt = admission.current ?? { caption: body, metadata: { ...info, id: crypto.randomUUID(), messageId: crypto.randomUUID(), direction: "OUT", expiresAt: null } };
        admission.current = attempt;
        await sendMessagingMedia(accountId, conversationId, row.peerId, attempt.caption, attempt.metadata, bytes);
      } else await sendMessagingText(accountId, conversationId, row.peerId, body, reportContext ?? undefined);
      if (alive.current) {
        nearBottom.current = true;
        // Only clear what this admission owned: typing that arrived while it was
        // in flight is newer intent and must survive.
        if (draftRevision.current === sendingRevision) { draftRevision.current++; setDraft(""); }
        if (sendingPhoto) setPhoto((current) => current === sendingPhoto ? null : current);
        if (!sendingPhoto && reportContext) clearReportContext(reportContext);
        admission.current = null;
      }
    } catch { if (alive.current) setError("Your message could not be saved. Your draft is still here."); }
    finally { if (alive.current) composer.current?.focus(); }
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
      if (alive.current) { setSheet(null); setSelectedMessageId(null); if (action === "delete") announce("Your copy was removed."); }
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
  const searchTerm = messageQuery.trim().toLowerCase();
  const searchMatches = searchTerm ? messages.filter(message => message.unsentAt === undefined && message.body.toLowerCase().includes(searchTerm)) : [];
  const gallery = photoAllowed ? messages.filter(message => message.messageType === "MEDIA" && message.unsentAt === undefined)
    .flatMap(message => { const attachment = media.find(item => item.messageId === message.id); return attachment ? [attachment] : []; }) : [];
  const confirming = sheet === "end" || sheet === "delete" || sheet === "unsend" || sheet === "clear";
  const confirmationTitle = sheet === "end" ? "End connection?" : sheet === "unsend" ? "Unsend message?" : sheet === "clear" ? "Clear chat for me?" : "Delete for me?";
  return <section className="fb-chat-page" aria-label="Conversation">
    <header className="fb-chat-header">
      <Link to="/chats" className="fb-chat-icon" aria-label="Back to chats"><ArrowLeft size={22} aria-hidden="true" /></Link>
      <ChatIdentity peerId={row?.peerId} name={name} muted={view?.ownMuted === true}
        status={!current ? "Saved chat" : current.mode === "CONNECTED" ? "Connected" : "Message request"} />
      <button type="button" className="fb-chat-icon" aria-label="Conversation options" disabled={threadBlocked} onClick={() => setSheet("actions")}><Info size={21} aria-hidden="true" /></button>
    </header>
    {threadBlocked && <div className="fb-chat-catchup">
      <RefreshCw size={18} aria-hidden="true" />
      <div role="status"><strong>{threadReadFailed || threadSync?.mode === "error" ? "Couldn’t update this conversation." : "Updating this conversation…"}</strong>
        <p>{threadReadFailed || threadSync?.mode === "error" ? "Your saved messages and draft are still here. Try again before continuing."
          : "We’re getting the latest changes before you continue."}</p></div>
      {(threadReadFailed || threadSync?.mode === "error") && <button type="button" onClick={() => {
        setThreadReadRetry(value => value + 1); void refreshMessaging(accountId).catch(() => undefined);
      }}>Try again</button>}
    </div>}
    <div className="fb-chat-messages" ref={scroll} inert={threadBlocked || undefined}>
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
          return <li key={message.id} data-chat-message={message.id} tabIndex={-1} className={own ? "fb-chat-line fb-chat-line-own" : "fb-chat-line"}>
            <div data-receipt-message={message.messageType === "TEXT" && message.body && message.unsentAt === undefined ? message.id : undefined} className={own ? "fb-chat-message fb-chat-message-own" : "fb-chat-message"}>
            <span className="sr-only">{own ? "You: " : `${name ? `@${name}` : "Member"}: `}</span>
            {message.unsentAt !== undefined ? <p>Message unsent</p> : <>
            {message.messageType === "MEDIA" && attachment && photoAllowed && <ChatPhoto key={attachment.id} accountId={accountId} conversationId={conversationId} attachment={attachment} onOpen={openPhoto} onReady={rememberPhoto} />}
            {message.contextReportId && <ChatReportContext reportId={message.contextReportId} safetyKey={view?.ownBlocked ? "blocked" : "clear"} />}
            {message.location && <ChatLocation location={message.location} />}
            {message.body ? <p dir="auto">{message.body}</p> : !attachment && message.messageType !== "LOCATION" && <p>{message.messageType === "MEDIA" ? "Photo loading…" : "Message unavailable"}</p>}
            {own && <span className="fb-chat-message-status">{pending?.status === "NEEDS_REVIEW" ? "Needs review — " : message.messageType === "MEDIA" && !attachment ? "Photo pending" : attachment && !["READY", "EVICTED"].includes(attachment.state) ? (attachment.state === "FAILED" ? "Failed — " : "Sending…") : message.server ? (visible && chat.status === "ready" && current?.mode === "CONNECTED" && !current.ownBlocked
              && message.unsentAt === undefined && receipt?.authority === receiptAuthority && receipt.readIds.has(message.id) ? "Read"
              : receipt?.readIds.has(message.id) && (!visible || chat.status !== "ready" || !current) ? "" : "Sent") : pending?.status === "FAILED" ? "Failed — " : "Sending…"}
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
    {error && !sheet && <p className="fb-chat-error" role="alert">{error}</p>}
    {photo && <div className="fb-chat-photo-draft" role="status">
      {photoAllowed && draftUrl && photo.prepared && <img src={draftUrl} alt="Selected photo" style={{ aspectRatio: `${photo.prepared.width} / ${photo.prepared.height}` }} />}
      {!photoAllowed ? "Photos are available when connected. Remove this photo to send text only." : photoPreparing ? "Preparing photo…" : photo.error ? "Could not prepare photo." : "Photo ready"}
      {photoAllowed && photo.error && <button type="button" onClick={() => void preparePhoto(photo.source)}>Retry</button>}
      <button type="button" aria-label="Remove photo" disabled={busy || !!admission.current} onClick={() => { photoController.current?.abort(); admission.current = null; setPhoto(null); setPhotoPreparing(false); }}>Remove</button>
    </div>}
    {canCompose && <>
        {reportContext && <p className="fb-chat-context-banner" role="status">
          Your next text message will show which report you’re asking about.
          <button type="button" onClick={() => clearReportContext(reportContext)}>Don’t attach</button>
        </p>}
        {view?.mode === "CONNECTED" && <input ref={photoInput} type="file" accept="image/*" aria-label="Choose photo" hidden onChange={(event) => {
          const source = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (source && Capacitor.getPlatform() !== "android") void preparePhoto(source);
        }} />}
      <PeerChatComposer value={draft} onChange={value => { draftRevision.current++; setDraft(value); }} onSend={() => void send()} inputRef={composer}
         busy={false} locked={threadBlocked || !!admission.current} canSend={!threadBlocked && (photo ? photoAllowed && !!photo.prepared : !!draft.trim())}
        photoAllowed={view?.mode === "CONNECTED"} onPhoto={() => void choosePhoto()}
        locationAllowed={locationAllowed} onLocation={() => setSheet("location")} />
    </>}
    {sheet === "location" && locationAllowed && <ChatLocationComposer key={locationAuthority.current}
      onClose={() => setSheet(null)} onSend={shareLocation} />}
    <MediaViewer items={viewerItems} index={activeViewer ? viewerItems.findIndex((item) => item.id === activeViewer.id) : null}
      onIndexChange={(index) => { if (viewer && viewerItems[index]) setViewer({ ...viewer, id: viewerItems[index].id }); }} onClose={closePhoto} />
    <ConfirmDialog open={confirming} onClose={() => setSheet(null)} title={confirmationTitle} busy={busy}
      confirmLabel={sheet === "end" ? "End connection" : sheet === "unsend" ? "Unsend" : sheet === "clear" ? "Clear for me" : "Delete for me"}
      cancelLabel={sheet === "end" ? "Keep connection" : "Cancel"}
      confirmDisabled={!current || (sheet === "end" ? current.mode !== "CONNECTED" : sheet === "clear" ? highest === 0 || outbox.length > 0
        : !selectedMessage?.server || (sheet === "unsend" && (selectedMessage.authorId !== accountId || selectedMessage.unsentAt !== undefined)))}
      onConfirm={() => { if (sheet === "end") void relationship("end"); else if (sheet === "delete" || sheet === "unsend" || sheet === "clear") void erase(sheet); }}>
      <p>{sheet === "end" ? "Your messages stay here. Either of you can send a new request."
        : sheet === "unsend" ? "Replace this message with ‘Message unsent’ for everyone. Messages already reported can still be reviewed."
          : sheet === "clear" ? "This clears your copy on your devices, not theirs." : "Remove this message from your devices, not the other person’s chat."}</p>
      {error && <p className="fb-chat-error" role="alert">{error}</p>}
    </ConfirmDialog>
    <AdaptiveTaskSurface open={sheet !== null && sheet !== "location" && !confirming} onClose={() => setSheet(null)} busy={busy}
      title={sheet === "search" ? "Search chat" : sheet === "media" ? "Conversation media" : sheet === "review" ? "Review message" : sheet === "message" ? "Message options" : "Conversation info"}>
      {sheet === "search" ? <div className="fb-chat-search-task">
        <label className="fb-chat-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Search saved messages" value={messageQuery} onChange={event => setMessageQuery(event.target.value)} /></label>
        <p role="status" className="fb-chat-secondary">{!searchTerm ? "Search the messages saved on this device." : `${searchMatches.length} ${searchMatches.length === 1 ? "message" : "messages"} found${searchMatches.length > 100 ? ". Showing the first 100." : ""}`}</p>
        <ul className="fb-chat-search-results">{searchMatches.slice(0, 100).map(message => <li key={message.id}>
          <button type="button" onClick={() => { nearBottom.current = false; setJumpTo(message.id); setSheet(null); }}><span className="fb-chat-secondary">{message.authorId === accountId ? "You" : name ? `@${name}` : "Member"}</span><span dir="auto">{message.body}</span></button>
        </li>)}</ul>
      </div> : sheet === "media" ? !photoAllowed ? <p>Photos are available when connected.</p> : gallery.length === 0 ? <p>No photos in this conversation yet.</p> : <ul className="fb-chat-gallery" aria-label="Conversation photos">
        {gallery.map(attachment => <li key={attachment.id}><ChatPhoto accountId={accountId} conversationId={conversationId} attachment={attachment} onOpen={openPhoto} onReady={ignorePhotoReadiness} /></li>)}
      </ul> : sheet === "review" ? <div className="fb-chat-sheet">
        <p>We couldn’t confirm this older message. Send the text shown here only, or remove your copy. This won’t recall anything already delivered.</p>
        <p className="fb-chat-review-copy" dir="auto">{selectedMessage?.body || "No saved text. To send a photo, attach it again as a new message."}</p>
        <div className="fb-chat-actions">
          <button type="button" disabled={busy || !selectedNeedsReview || !selectedMessage?.body.trim() || !canCompose} onClick={() => void reviewMessage("send")}>Send text only</button>
          <button type="button" disabled={busy || !selectedNeedsReview} onClick={() => void reviewMessage("delete")}>Delete for me</button>
        </div>
      </div> : sheet === "message" ? <div className="fb-chat-sheet">
        <button type="button" disabled={busy || !current || !selectedMessage} onClick={() => setSheet("delete")}>Delete for me</button>
        {selectedMessage?.authorId === accountId && selectedMessage.unsentAt === undefined &&
          <button type="button" disabled={busy || !current} onClick={() => setSheet("unsend")}>Unsend</button>}
        {selectedMessage?.authorId !== accountId && selectedMessage?.unsentAt === undefined &&
          <button type="button" disabled={busy || !current || !selectedMessage || !row}
            onClick={() => { setSheet(null); setReportTarget("message"); }}>Report message</button>}
      </div> : <div className="fb-chat-sheet">
        {name && <Link className="fb-chat-info-row" to={`/u/${encodeURIComponent(name)}`}><UserRound size={20} aria-hidden="true" /><span>View profile</span></Link>}
        <button type="button" className="fb-chat-info-row" onClick={() => setSheet("search")}><Search size={20} aria-hidden="true" /><span>Search chat</span></button>
        <button type="button" className="fb-chat-info-row" onClick={() => setSheet("media")}><Images size={20} aria-hidden="true" /><span>Media</span></button>
        <hr className="fb-chat-info-divider" />
        {typeof view?.ownMuted === "boolean" ? <PreferenceSwitchRow className="fb-chat-mute" title="Mute notifications" icon={BellOff}
          checked={view.ownMuted} disabled={busy || chat.status !== "ready" || typeof current?.ownMuted !== "boolean"}
          onChange={muted => void setMuted(muted)} /> : <p className="fb-chat-secondary">Sync to change chat notifications.</p>}
        <RetrySync accountId={accountId} labelled />
        <Link className="fb-chat-info-row" to="/settings/privacy/messages"><Settings2 size={20} aria-hidden="true" /><span>Message settings</span></Link>
        <hr className="fb-chat-info-divider" />
        <button type="button" className="fb-chat-info-row" disabled={busy || !current} onClick={() => void relationship(view?.ownHidden ? "unhide" : "hide")}><Archive size={20} aria-hidden="true" /><span>{view?.ownHidden ? "Move to inbox" : view?.mode === "CONNECTED" ? "Archive" : "Hide request"}</span></button>
        {view?.mode === "CONNECTED" && <button type="button" className="fb-chat-info-row" disabled={busy || !current} onClick={() => setSheet("end")}><LogOut size={20} aria-hidden="true" /><span>End connection</span></button>}
        <button type="button" className="fb-chat-info-row" disabled={busy || !current || highest === 0 || outbox.length > 0} onClick={() => setSheet("clear")}><Trash2 size={20} aria-hidden="true" /><span>Clear chat for me</span></button>
        {outbox.length > 0 && <p className="fb-chat-secondary">Wait for messages still sending before clearing this chat.</p>}
        <hr className="fb-chat-info-divider" />
        {row && <div className="fb-chat-info-block"><ShieldBan size={20} aria-hidden="true" /><BlockControl userId={row.peerId} name={name || "this account"} blocked={current?.ownBlocked}
          onChanged={() => { void refreshMessaging(accountId).catch(() => undefined); }} /></div>}
        {row && <button type="button" className="fb-chat-info-row" onClick={() => { setSheet(null); setReportTarget("account"); }}><Flag size={20} aria-hidden="true" /><span>Report account</span></button>}
      </div>}
      {error && <p className="fb-chat-error" role="alert">{error}</p>}
    </AdaptiveTaskSurface>
    <ReportSheet open={reportTarget !== null} target={reportTarget === "account" && row ? { targetType: "USER", targetId: row.peerId }
      : reportTarget === "message" && selectedMessage && selectedMessage.unsentAt === undefined
        ? { targetType: "MESSAGE", targetId: selectedMessage.id, accountId, body: selectedMessage.body } : null}
      onClose={() => setReportTarget(null)} />
  </section>;
}
