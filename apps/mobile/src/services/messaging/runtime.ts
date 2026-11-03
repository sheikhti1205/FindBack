import { Capacitor } from "@capacitor/core";
import type { MediaAttachment, OutboxEntry, StaticLocation, StoredHumanMessage } from "./history";
import type { MediaMetadata } from "./media";
import type { ConversationProjection, ConversationSummary } from "./conversationIndex";
import { openPlatformMessagingHistory, purgePlatformMessagingAccount, type PlatformMessagingHandle } from "./platformHistory";
import { beginMessagingAccountDeletion } from "./scopedMediaBytes";
import { createSupabaseMessagingSession } from "./supabaseSession";
import { isUuid, uuid } from "./validation";
import type { MessagingPreferences } from "./session";
import { onRealtime } from "../realtime";
import { getSupabaseBackendUrl } from "../supabaseClient";

export interface MessagingThreadSync {
  conversationId: string;
  mode: "checking" | "ready" | "soft" | "blocking" | "error";
  missing: number | null;
  /** UI must finish this post-reconciliation durable read before interaction. */
  appliedRevision?: number;
}

export interface MessagingRuntimeSnapshot {
  accountId: string | null;
  status: "closed" | "opening" | "ready" | "offline" | "error";
  conversations: ConversationSummary[];
  /** Last fully fetched projection set in this live account lifetime. Cleared
   * when offline/refreshing; cached local projections are kept separately. */
  currentProjections: Readonly<Record<string, ConversationProjection>> | null;
  /** Ephemeral active-thread gate. Only durable session reconciliation unlocks it. */
  threadSync: MessagingThreadSync | null;
  error: string | null;
  /** Invalidates consumer thread reads after local persistence or synchronization. */
  revision: number;
}

export const EMPTY_MESSAGING_SNAPSHOT: MessagingRuntimeSnapshot = Object.freeze({
  accountId: null, status: "closed", conversations: [], currentProjections: null, threadSync: null, error: null, revision: 0,
});

type Session = ReturnType<typeof createSupabaseMessagingSession>;
interface Owner {
  handle: PlatformMessagingHandle;
  session: Session;
  generation: number;
  refreshing: Promise<void> | null;
  /**
   * A hint that arrived while a pass was already running. Full outranks fast:
   * a relationship/authority pass must never be downgraded by a message hint.
   */
  pendingRefresh: RefreshMode | null;
  /** REGISTER has completed for this owner; SYNC is only valid after it. */
  started: boolean;
  authorityVersion: number;
  activeThread: { conversationId: string } | null;
  detach: () => void;
}

/**
 * Foreground message traffic and relationship/authority recovery are different
 * costs (owner handoff 2026-11-03):
 *
 *   fast — flush the pending outbox, drain the newest authorized mailbox page
 *          (persist + ACK), reload local summaries. No VIEWS scan, no full
 *          history drain, no media sweep: those are what made an ordinary
 *          message wait on unrelated reconciliation.
 *   full — startup, reconnect/focus, relationship or block changes, explicit
 *          Sync, media sends and error recovery. Everything the old path did.
 */
type RefreshMode = "fast" | "full";

let snapshot = EMPTY_MESSAGING_SNAPSHOT;
let generation = 0;
let desiredAccount: string | null = null;
let desiredSession: string | null | undefined;
let current: Owner | null = null;
let lifecycle: Promise<void> = Promise.resolve();
// A switch can detach A before deletion is confirmed. Preserve failed teardown
// as well as in-flight teardown instead of losing it in lifecycle's UI catch.
const accountClosing = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function publish(value: MessagingRuntimeSnapshot) {
  snapshot = value;
  for (const listener of listeners) listener();
}

export function subscribeMessagingRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMessagingRuntimeSnapshot(): MessagingRuntimeSnapshot { return snapshot; }

function webInstallationId(): string {
  const key = "findback.messaging.installation.v1";
  const stored = localStorage.getItem(key);
  if (stored !== null) return uuid(stored);
  const id = uuid(crypto.randomUUID());
  localStorage.setItem(key, id);
  if (localStorage.getItem(key) !== id) throw new Error("Chat installation could not be saved");
  return id;
}

function assertOwner(owner: Owner) {
  if (current !== owner || owner.generation !== generation || desiredAccount !== owner.handle.scope.accountId) {
    throw new Error("Messaging account changed");
  }
}

function ownerFor(accountId: string): Owner {
  const owner = current;
  if (!owner || owner.handle.scope.accountId !== uuid(accountId)) throw new Error("Chat is not ready");
  assertOwner(owner);
  return owner;
}

async function reload(owner: Owner) {
  const conversations = await owner.handle.history.listConversations();
  assertOwner(owner);
  publish({ ...snapshot, conversations, revision: snapshot.revision + 1 });
}

function invalidateAuthority(owner: Owner) {
  owner.authorityVersion++;
  if (current === owner) publish({ ...snapshot, currentProjections: null,
    threadSync: owner.activeThread ? { ...owner.activeThread, mode: "checking", missing: null } : null });
}

async function reconcileActiveThread(owner: Owner) {
  const thread = owner.activeThread;
  if (!thread) return;
  const authorityVersion = owner.authorityVersion;
  const live = () => current === owner && owner.generation === generation && owner.activeThread === thread
    && owner.authorityVersion === authorityVersion;
  try {
    await owner.session.reconcileConversation(thread.conversationId, gate => {
      if (live() && gate.mode !== "ready") publish({ ...snapshot, threadSync: { conversationId: thread.conversationId, mode: gate.mode, missing: gate.missing } });
    });
    if (!live()) return;
    await reload(owner);
    if (live()) publish({ ...snapshot, threadSync: { ...thread, mode: "ready", missing: 0, appliedRevision: snapshot.revision } });
  } catch {
    if (live()) publish({ ...snapshot, threadSync: { ...thread, mode: "error", missing: null } });
  }
}

/** One active transcript lease; closing/switching cannot publish a late old gate.
 * Network work stays in the ordinary serialized refresh owner, never a UI lane. */
export function watchMessagingThread(accountId: string, conversationId: string): () => void {
  const owner = ownerFor(accountId), thread = { conversationId: uuid(conversationId) };
  owner.activeThread = thread;
  publish({ ...snapshot, threadSync: { ...thread, mode: "checking", missing: null } });
  void requestRefresh(owner, "full");
  return () => {
    if (owner.activeThread !== thread) return;
    owner.activeThread = null;
    if (current === owner) publish({ ...snapshot, threadSync: null });
  };
}

function rememberClose(accountId: string, work: Promise<void>): Promise<void> {
  accountClosing.set(accountId, work);
  void work.then(() => {
    if (accountClosing.get(accountId) === work) accountClosing.delete(accountId);
  }, () => undefined);
  return work;
}

function closePlatformHandle(handle: PlatformMessagingHandle): Promise<void> {
  return rememberClose(handle.scope.accountId, handle.close());
}

function closeOwner(owner: Owner): Promise<void> {
  owner.detach();
  // Session abort and history invalidation are synchronous. Platform close owns
  // releasing the one-account lease after the same durable teardown settles.
  return rememberClose(owner.handle.scope.accountId,
    Promise.all([owner.session.close(), owner.handle.close()]).then(() => undefined));
}

/** Signals only trigger ordinary mailbox synchronization; no signal payload is
 * ever interpreted as a message, relationship change, or persistence receipt. */
function attachResume(owner: Owner): () => void {
  if (typeof window === "undefined") return () => undefined;
  const resume = () => { void requestRefresh(owner, "full"); };
  const visible = () => { if (document.visibilityState === "visible") resume(); };
  const offline = () => {
    if (current === owner) {
      invalidateAuthority(owner);
      publish({ ...snapshot, status: "offline", currentProjections: null, error: null });
    }
  };
  const unsubscribeChat = onRealtime("chat:invalidate", (payload) => {
    if (current !== owner || owner.generation !== generation || payload.accountId !== owner.handle.scope.accountId) return;
    // The payload is a content-free hint, never a message or receipt. The
    // fast path settles the new message and the sender's own echo; unrelated
    // projections and media work stay with the full pass.
    void requestRefresh(owner, "fast");
  });
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visible);
  return () => {
    unsubscribeChat();
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", visible);
  };
}

function requestRefresh(owner: Owner, mode: RefreshMode): Promise<void> {
  // Full is the only mode that may drop live receipt authority; it refetches it.
  if (mode === "full") invalidateAuthority(owner);
  if (owner.refreshing) {
    // A send/wake can arrive after the running flush already exhausted its
    // outbox. Coalesce one follow-up instead of dropping that invalidation, and
    // never let a fast hint downgrade a queued full pass.
    owner.pendingRefresh = mode === "full" || owner.pendingRefresh === "full" ? "full" : "fast";
    return owner.refreshing;
  }
  const run = mode === "full" || !owner.started ? "full" : "fast";
  const work = async () => {
    const authorityVersion = owner.authorityVersion;
    try {
      assertOwner(owner);
      if (run === "full") publish({ ...snapshot, currentProjections: null });
      // Registration is idempotent and precedes SEND/SYNC for this installation.
      let projections: ConversationProjection[] | null = null;
      if (run === "full") {
        await owner.session.start(owner.handle.platform);
        // Resolve own end/block before considering cached media send eligibility.
        projections = await owner.session.refreshConversations();
        // Only a completed full pass earns the fast path: SYNC without current
        // projections would leave the composer unable to judge eligibility.
        owner.started = true;
      }
      // Open/reconnect compare the active thread before pending SEND admission.
      // A thread failure stays gated while unrelated mailbox recovery can proceed.
      await reconcileActiveThread(owner); assertOwner(owner);
      let sendFailed = false;
      try { await owner.session.flush(); } catch { sendFailed = true; }
      assertOwner(owner);
      if (run === "full") {
        // Fetch is bounded to 100. Drain ordinary replay rather than treating
        // one batch as complete history. Limit work per wake.
        for (let page = 0; page < 10; page++) {
          assertOwner(owner);
          if (await owner.session.sync() < 100) break;
        }
      } else if (await owner.session.sync() > 0) {
        // The fast path drains the newest authorized page (persist + ACK). A
        // full page means more is waiting: ask for one bounded follow-up pass
        // rather than looping here and holding the hint open.
        owner.pendingRefresh = owner.pendingRefresh === "full" ? "full" : "fast";
      }
      // A committed incoming MEDIA parent is durable now, but the fast path
      // does not discover/download bytes. Publish catch-up promptly, then
      // coalesce one bounded full recovery instead of leaving a loading ghost.
      if (run === "fast" && owner.session.needsMediaDiscovery()) owner.pendingRefresh = "full";
      let mediaFailed = false;
      // Uploading already-admitted photos is bounded (10 per pass) and is a no-op
      // when nothing is queued: a photo must never wait for the next full sweep.
      // The download/ACK sweep stays with the full pass.
      try { await owner.session.flushMedia(); } catch { mediaFailed = true; }
      assertOwner(owner);
      if (run === "full") {
        // An outgoing failure must never starve independently authorized incoming
        // deliveries or lost-ACK settlement. Each session pass is bounded.
        try { await owner.session.syncMedia(); } catch { mediaFailed = true; }
      }
      await reload(owner);
      assertOwner(owner);
      const projectionsNow = run === "full" && projections && authorityVersion === owner.authorityVersion
        ? Object.fromEntries(projections.map((projection) => [projection.conversationId, projection]))
        // An end/block/preference change or newer wake during a slow photo must
        // not restore earlier receipt authority; the coalesced full pass refetches.
        : run === "full" ? null : snapshot.currentProjections;
      publish({ ...snapshot, status: "ready", error: mediaFailed ? "Some photos could not sync. Try again."
        : sendFailed ? "Some messages could not send. Try again." : null,
        currentProjections: projectionsNow });
    } catch {
      if (current !== owner || owner.generation !== generation) return;
      // Local data remains primary and usable even if the server is unreachable.
      await reload(owner).catch(() => undefined);
      if (current === owner) publish({ ...snapshot, status: "offline", currentProjections: null,
        threadSync: owner.activeThread ? { ...owner.activeThread, mode: "error", missing: null } : null,
        error: "Chat could not sync. Try again." });
    }
  };
  owner.refreshing = work().finally(() => {
    owner.refreshing = null;
    const pending = owner.pendingRefresh;
    owner.pendingRefresh = null;
    if (pending && current === owner && owner.generation === generation) void requestRefresh(owner, pending);
  });
  return owner.refreshing;
}

/** The canonical auth owner calls this on sign-in/switch and clears it on every
 * sign-out path. Old rows disappear immediately, before any asynchronous close.
 * The serialized lifecycle also handles React StrictMode setup/cleanup/setup. */
export function setMessagingAccount(accountId: string | null, sessionId?: string | null): void {
  // This runs in a passive effect, so a throw here unmounts the entire tree and
  // takes every non-chat screen with it. An id that is not a UUID cannot be a
  // Supabase account, so chat stays closed for it instead: the additive lane
  // never becomes a way for the shell to fail.
  const next = accountId !== null && isUuid(accountId) && (sessionId===undefined || (sessionId!==null && isUuid(sessionId))) ? accountId : null;
  const nextSession=next===null ? undefined : sessionId;
  if (desiredAccount === next && desiredSession === nextSession) return;
  desiredAccount = next;
  desiredSession = nextSession;
  const ticket = ++generation;
  const prior = current;
  current = null;
  const closing = prior ? closeOwner(prior) : Promise.resolve();
  // Attach rejection handling immediately; lifecycle work may still be queued.
  const settledClose = closing.then(() => ({ ok: true as const }), () => ({ ok: false as const }));
  publish(next === null ? EMPTY_MESSAGING_SNAPSHOT : {
    accountId: next, status: "opening", conversations: [], currentProjections: null, threadSync: null, error: null, revision: 0,
  });
  const start = async () => {
    const closed = await settledClose;
    if (ticket !== generation || next === null) return;
    if (!closed.ok) throw new Error("Chat storage could not close");
    let handle: PlatformMessagingHandle | undefined;
    try {
      handle = await openPlatformMessagingHistory({ accountId: next, media: { backendUrl: getSupabaseBackendUrl() },
        ...(Capacitor.isNativePlatform() ? {} : { deviceId: webInstallationId() }) });
      if (ticket !== generation) { await closePlatformHandle(handle); return; }
      const owner: Owner = { handle, session: createSupabaseMessagingSession(handle.scope, handle.history),
        generation: ticket, refreshing: null, pendingRefresh: null, started: false,
        authorityVersion: 0, activeThread: null, detach: () => undefined };
      current = owner;
      owner.detach = attachResume(owner);
      await reload(owner); // Publish local rows before attempting network work.
      void requestRefresh(owner, "full");
    } catch (error) {
      if (current?.generation === ticket) {
        const failed = current;
        current = null;
        await closeOwner(failed).catch(() => undefined);
      } else if (handle) await closePlatformHandle(handle).catch(() => undefined);
      throw error;
    }
  };
  lifecycle = lifecycle.then(start).catch(() => {
    if (ticket === generation && next !== null) publish({ ...snapshot, status: "error",
      error: "Chat history could not open. Try again." });
  });
}

export function clearMessagingRuntime(): void { setMessagingAccount(null); }

/** Confirmed deletion for captured A, even after B becomes current. Ordinary
 * logout never calls this. Durable pending work belongs to the storage registry,
 * not this promise or the dismissible auth UI. No cleanup session/network work. */
export function purgeMessagingAccount(accountId: string): Promise<void> {
  const target = uuid(accountId);
  if (desiredAccount === target) setMessagingAccount(null);
  const admitted = beginMessagingAccountDeletion(target);
  // Handle rejection immediately while prior lifecycle work may still be queued.
  void admitted.catch(() => undefined);
  const cleanup = lifecycle.then(async () => {
    await admitted;
    await accountClosing.get(target);
    await purgePlatformMessagingAccount(target);
  });
  lifecycle = cleanup.catch(() => undefined);
  return cleanup;
}

/** Account-scoped wake only. Payloads never become message or receipt truth. */
export function invalidateMessaging(accountId: string): void {
  const owner = current;
  if (!owner || desiredAccount !== accountId || owner.handle.scope.accountId !== accountId || owner.generation !== generation) return;
  // A push is a message-scoped hint: settle messages fast, leave reconciliation
  // to focus/reconnect/relationship passes.
  void requestRefresh(owner, "fast");
}

export function refreshMessaging(accountId: string): Promise<void> {
  if (!current && desiredAccount === accountId) {
    // Explicit retry may reopen after a recoverable startup failure.
    const sessionId=desiredSession;
    setMessagingAccount(null);
    setMessagingAccount(accountId,sessionId);
    return lifecycle;
  }
  return requestRefresh(ownerFor(accountId), "full");
}

export async function readMessagingThread(accountId: string, conversationId: string): Promise<StoredHumanMessage[]> {
  const owner = ownerFor(accountId);
  const rows = await owner.handle.history.listMessages(uuid(conversationId));
  assertOwner(owner);
  return rows;
}

export async function readMessagingThreadState(accountId: string, conversationId: string): Promise<{
  messages: StoredHumanMessage[]; outbox: OutboxEntry[]; media: MediaAttachment[];
}> {
  const owner = ownerFor(accountId);
  const messages = await owner.handle.history.listMessages(uuid(conversationId));
  const ids = new Set(messages.map((message) => message.id));
  const outbox = (await owner.handle.history.listOutbox()).filter((entry) => ids.has(entry.messageId));
  const media = (await owner.handle.history.listMedia(conversationId)).filter((entry) => ids.has(entry.messageId));
  assertOwner(owner);
  return { messages, outbox, media };
}

/** Prepared immutable derivative bytes only; picker/normalization stays in the
 * canonical media pipeline. Caller retains both stable IDs across uncertain
 * admission errors, instead of generating a new message on retry. */
export async function sendMessagingMedia(accountId: string, conversationId: string, peerId: string, body: string,
  metadata: MediaMetadata, bytes: ArrayBuffer): Promise<string> {
  const owner = ownerFor(accountId), id = uuid(metadata.messageId);
  await owner.session.sendMedia({ id, conversationId: uuid(conversationId), authorId: uuid(accountId),
    recipientId: uuid(peerId), body }, metadata, bytes);
  assertOwner(owner);
  await reload(owner);
  // The upload/sync media lanes live on the full pass; a photo must not wait for
  // a later focus to start uploading.
  void requestRefresh(owner, "full");
  return id;
}

export async function readMessagingMedia(accountId: string, attachmentId: string): Promise<ArrayBuffer | null> {
  const owner = ownerFor(accountId);
  const bytes = await owner.handle.history.readMedia(uuid(attachmentId));
  assertOwner(owner); return bytes;
}

export async function downloadMessagingMedia(accountId: string, conversationId: string, attachmentId: string): Promise<void> {
  const owner = ownerFor(accountId);
  await owner.session.downloadMedia(uuid(conversationId), uuid(attachmentId));
  assertOwner(owner); await reload(owner);
}

/**
 * Report-linked first contact/message. The report id travels with the message so
 * the recipient can resolve the report live; it is never a copied snapshot and
 * it never changes a plain text send into a different capability.
 */
export async function sendMessagingText(accountId: string, conversationId: string, peerId: string, body: string,
  contextReportId?: string): Promise<string> {
  const owner = ownerFor(accountId);
  const id = uuid(crypto.randomUUID());
  await owner.session.send({ id, conversationId: uuid(conversationId), authorId: uuid(accountId), recipientId: uuid(peerId), body,
    ...(contextReportId ? { messageType: "TEXT" as const, contextReportId: uuid(contextReportId) } : {}) });
  assertOwner(owner);
  await reload(owner); // Queued send appears without waiting for connectivity.
  // Settle this send and the peer's echo; projections/media stay on full passes.
  void requestRefresh(owner, "fast");
  return id;
}

/** Connected-only one-time static share. There is no request-stage path and no
 * background tracking: the caller supplies one explicit coordinate. */
export async function sendMessagingLocation(accountId: string, conversationId: string, peerId: string,
  location: StaticLocation): Promise<string> {
  const owner = ownerFor(accountId);
  const id = uuid(crypto.randomUUID());
  await owner.session.send({ id, conversationId: uuid(conversationId), authorId: uuid(accountId), recipientId: uuid(peerId),
    body: "", messageType: "LOCATION", location });
  assertOwner(owner);
  await reload(owner);
  // Static location settles on the canonical echo, not on a media/projection sweep.
  void requestRefresh(owner, "fast");
  return id;
}

/** Explicit user recovery, never called by wake/retry. Re-admit the exact old
 * identity as TEXT only after the user chose to send the displayed text alone. */
export async function recoverMessagingText(accountId: string, conversationId: string, messageId: string): Promise<void> {
  const owner = ownerFor(accountId), history = owner.handle.history;
  const message = await history.getMessage(uuid(messageId));
  const queued = (await history.listOutbox()).find((entry) => entry.messageId === messageId);
  assertOwner(owner);
  if (!message || message.conversationId !== uuid(conversationId) || message.authorId !== accountId
    || message.server || message.unsentAt !== undefined || message.messageType || !message.body.trim()
    || queued?.status !== "NEEDS_REVIEW") throw new Error("Message no longer needs review");
  await owner.session.send(message);
  assertOwner(owner); await reload(owner); void requestRefresh(owner, "fast");
}

/**
 * Explicit user retry of one failed queued send. Rebinds it to the relationship
 * boundary the user is acting in, then flushes.
 *
 * This is the only path allowed to move a stored boundary. An automatic flush
 * deliberately refuses a stale send instead of recasting it, so a retry that
 * only re-flushed the same row could never succeed — the row has to be rebound
 * first, and only a human choosing "Retry" may authorize that.
 */
export async function retryMessagingMessage(accountId: string, conversationId: string, messageId: string): Promise<void> {
  const owner = ownerFor(accountId);
  const message = await owner.handle.history.getMessage(uuid(messageId));
  if (!message || message.conversationId !== uuid(conversationId) || message.authorId !== accountId) {
    throw new Error("Message unavailable");
  }
  await owner.session.retryOutgoing(messageId);
  assertOwner(owner);
  await reload(owner);
  try {
    await owner.session.flush();
  } finally {
    // The rebind already happened, so show the real durable state even when the
    // resend fails again.
    assertOwner(owner);
    await reload(owner);
    void requestRefresh(owner, "fast");
  }
}

export async function markMessagingConversationRead(accountId: string, conversationId: string, throughSequence: number): Promise<void> {
  const owner = ownerFor(accountId);
  await owner.handle.history.markConversationRead(uuid(conversationId), throughSequence);
  assertOwner(owner);
  await reload(owner);
}

function receiptOwner(accountId: string, conversationId: string) {
  const owner = ownerFor(accountId);
  const projections = snapshot.currentProjections;
  const view = projections?.[uuid(conversationId)];
  if (snapshot.status !== "ready" || !projections || view?.mode !== "CONNECTED" || view.ownBlocked) {
    throw new Error("Receipt context unavailable");
  }
  return { owner, projections };
}

export async function fetchMessagingReceiptView(accountId: string, conversationId: string, messageIds: string[], signal: AbortSignal) {
  const { owner, projections } = receiptOwner(accountId, conversationId);
  const value = await owner.session.receiptView(conversationId, messageIds, signal);
  assertOwner(owner);
  if (signal.aborted || snapshot.currentProjections !== projections || snapshot.status !== "ready") throw new Error("Receipt context changed");
  return value;
}

export async function observeMessagingReceipt(accountId: string, conversationId: string, context: string, messageId: string, signal: AbortSignal) {
  const { owner, projections } = receiptOwner(accountId, conversationId);
  const value = await owner.session.observeReceipt(conversationId, context, messageId, signal);
  assertOwner(owner);
  if (signal.aborted || snapshot.currentProjections !== projections || snapshot.status !== "ready") throw new Error("Receipt context changed");
  return value;
}

export async function requestMessagingConversation(accountId: string, peerId: string): Promise<string> {
  const owner = ownerFor(accountId);
  const id = await owner.session.request(uuid(peerId));
  assertOwner(owner);
  await requestRefresh(owner, "full");
  assertOwner(owner);
  return id;
}

/** Explicit preference intent, never an optimistic cached-state toggle. */
export async function setMessagingMuted(accountId: string, conversationId: string, muted: boolean): Promise<void> {
  const owner = ownerFor(accountId), id = uuid(conversationId);
  if (snapshot.status !== "ready" || typeof snapshot.currentProjections?.[id]?.ownMuted !== "boolean") {
    throw new Error("Sync this chat before changing notifications");
  }
  invalidateAuthority(owner);
  try {
    await owner.session.setMuted(id, muted);
    assertOwner(owner);
  } finally {
    if (current === owner && owner.generation === generation) await requestRefresh(owner, "full");
  }
}

export async function changeMessagingRelationship(accountId: string, conversationId: string,
  action: "accept" | "end" | "block" | "hide" | "unhide" | "decline"): Promise<void> {
  const owner = ownerFor(accountId);
  invalidateAuthority(owner);
  try {
    if (action === "hide" || action === "unhide" || action === "decline") {
      const operations = { hide: "HIDE", unhide: "UNHIDE", decline: "DECLINE" } as const;
      await owner.session.setPrivateState(uuid(conversationId), operations[action]);
    } else await owner.session[action](uuid(conversationId));
    assertOwner(owner);
  } finally {
    if (current === owner && owner.generation === generation) await requestRefresh(owner, "full");
  }
}

/**
 * Shared block/unblock intent from any surface (thread, profile, settings) runs
 * through the live session's media fence. A pending photo upload or download can
 * then never commit under the authority the user just revoked. The server stays
 * authoritative; this only stops local work that is already in flight.
 */
export async function runMessagingAuthorityAction<T>(accountId: string | null, work: () => Promise<T>): Promise<T> {
  const owner = current;
  if (!accountId || !owner || desiredAccount !== accountId
    || owner.handle.scope.accountId !== accountId || owner.generation !== generation) return work();
  invalidateAuthority(owner);
  try {
    return await owner.session.fence(work);
  } finally {
    if (current === owner && owner.generation === generation) void requestRefresh(owner, "full");
  }
}

export async function fetchMessagingPreferences(accountId: string): Promise<MessagingPreferences> {
  const owner = ownerFor(accountId);
  const preferences = await owner.session.getPreferences();
  assertOwner(owner);
  return preferences;
}

export async function removeMessagingMessage(accountId: string, conversationId: string, messageId: string, unsend: boolean): Promise<void> {
  const owner = ownerFor(accountId);
  invalidateAuthority(owner);
  await owner.session.removeMessage(uuid(conversationId), uuid(messageId), unsend);
  assertOwner(owner);
  await reload(owner);
  void requestRefresh(owner, "full");
}

export async function clearMessagingConversation(accountId: string, conversationId: string, throughSequence: number): Promise<void> {
  const owner = ownerFor(accountId);
  invalidateAuthority(owner);
  await owner.session.clearConversation(uuid(conversationId), throughSequence);
  assertOwner(owner);
  await reload(owner);
  void requestRefresh(owner, "full");
}

export async function setMessagingPreference(accountId: string, key: keyof MessagingPreferences, enabled: boolean): Promise<MessagingPreferences> {
  const owner = ownerFor(accountId);
  invalidateAuthority(owner);
  try {
    if (key === "openMessages") await owner.session.setOpenMessages(enabled);
    else if (key === "readReceipts") await owner.session.setReadReceipts(enabled);
    else throw new Error("Invalid chat preference");
    assertOwner(owner);
    return await fetchMessagingPreferences(accountId);
  } finally {
    if (current === owner && owner.generation === generation) void requestRefresh(owner, "full");
  }
}
