import { Capacitor } from "@capacitor/core";
import type { MediaAttachment, OutboxEntry, StoredHumanMessage } from "./history";
import type { MediaMetadata } from "./media";
import type { ConversationProjection, ConversationSummary } from "./conversationIndex";
import { openPlatformMessagingHistory, purgePlatformMessagingAccount, type PlatformMessagingHandle } from "./platformHistory";
import { beginMessagingAccountDeletion } from "./scopedMediaBytes";
import { createSupabaseMessagingSession } from "./supabaseSession";
import { isUuid, uuid } from "./validation";
import type { MessagingPreferences } from "./session";
import { onRealtime } from "../realtime";
import { getSupabaseBackendUrl } from "../supabaseClient";

export interface MessagingRuntimeSnapshot {
  accountId: string | null;
  status: "closed" | "opening" | "ready" | "offline" | "error";
  conversations: ConversationSummary[];
  /** Last fully fetched projection set in this live account lifetime. Cleared
   * when offline/refreshing; cached local projections are kept separately. */
  currentProjections: Readonly<Record<string, ConversationProjection>> | null;
  error: string | null;
  /** Invalidates consumer thread reads after local persistence or synchronization. */
  revision: number;
}

export const EMPTY_MESSAGING_SNAPSHOT: MessagingRuntimeSnapshot = Object.freeze({
  accountId: null, status: "closed", conversations: [], currentProjections: null, error: null, revision: 0,
});

type Session = ReturnType<typeof createSupabaseMessagingSession>;
interface Owner {
  handle: PlatformMessagingHandle;
  session: Session;
  generation: number;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
  authorityVersion: number;
  detach: () => void;
}

let snapshot = EMPTY_MESSAGING_SNAPSHOT;
let generation = 0;
let desiredAccount: string | null = null;
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
  if (current === owner) publish({ ...snapshot, currentProjections: null });
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
  const resume = () => { void refreshOwner(owner); };
  const visible = () => { if (document.visibilityState === "visible") resume(); };
  const offline = () => {
    if (current === owner) {
      invalidateAuthority(owner);
      publish({ ...snapshot, status: "offline", currentProjections: null, error: null });
    }
  };
  const unsubscribeChat = onRealtime("chat:invalidate", (payload) => {
    if (current !== owner || owner.generation !== generation || payload.accountId !== owner.handle.scope.accountId) return;
    // A hint invalidates live receipt authority immediately; the canonical
    // owner refetches mailbox, erasure state and relationship projections.
    publish({ ...snapshot, currentProjections: null });
    void refreshOwner(owner);
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

function refreshOwner(owner: Owner): Promise<void> {
  invalidateAuthority(owner);
  if (owner.refreshing) {
    // A send/wake can arrive after the running flush already exhausted its
    // outbox. Coalesce one follow-up instead of dropping that invalidation.
    owner.refreshAgain = true;
    return owner.refreshing;
  }
  const work = async () => {
    const authorityVersion = owner.authorityVersion;
    try {
      assertOwner(owner);
      publish({ ...snapshot, currentProjections: null });
      // Registration is idempotent and precedes SEND/SYNC for this installation.
      await owner.session.start(owner.handle.platform);
      // Resolve own end/block before considering cached media send eligibility.
      const projections = await owner.session.refreshConversations();
      let sendFailed = false;
      try { await owner.session.flush(); } catch { sendFailed = true; }
      assertOwner(owner);
      // Fetch is bounded to 100. Drain ordinary replay rather than treating one
      // batch as complete history. Limit work per wake; a later resume continues.
      for (let page = 0; page < 10; page++) {
        assertOwner(owner);
        if (await owner.session.sync() < 100) break;
      }
      // An outgoing failure must never starve independently authorized incoming
      // deliveries or lost-ACK settlement. Each session pass is bounded.
      let mediaFailed = false;
      try { await owner.session.flushMedia(); } catch { mediaFailed = true; }
      assertOwner(owner);
      try { await owner.session.syncMedia(); } catch { mediaFailed = true; }
      await reload(owner);
      assertOwner(owner);
      publish({ ...snapshot, status: "ready", error: mediaFailed ? "Some photos could not sync. Try again."
        : sendFailed ? "Some messages could not send. Try again." : null,
        // An end/block/preference change or newer wake during a slow photo must
        // not restore earlier receipt authority. The coalesced pass refetches it.
        currentProjections: authorityVersion === owner.authorityVersion
          ? Object.fromEntries(projections.map((projection) => [projection.conversationId, projection])) : null });
    } catch {
      if (current !== owner || owner.generation !== generation) return;
      // Local data remains primary and usable even if the server is unreachable.
      await reload(owner).catch(() => undefined);
      if (current === owner) publish({ ...snapshot, status: "offline", currentProjections: null,
        error: "Chat could not sync. Try again." });
    }
  };
  owner.refreshing = work().finally(() => {
    owner.refreshing = null;
    if (owner.refreshAgain && current === owner && owner.generation === generation) {
      owner.refreshAgain = false;
      void refreshOwner(owner);
    }
  });
  return owner.refreshing;
}

/** The canonical auth owner calls this on sign-in/switch and clears it on every
 * sign-out path. Old rows disappear immediately, before any asynchronous close.
 * The serialized lifecycle also handles React StrictMode setup/cleanup/setup. */
export function setMessagingAccount(accountId: string | null): void {
  // This runs in a passive effect, so a throw here unmounts the entire tree and
  // takes every non-chat screen with it. An id that is not a UUID cannot be a
  // Supabase account, so chat stays closed for it instead: the additive lane
  // never becomes a way for the shell to fail.
  const next = accountId !== null && isUuid(accountId) ? accountId : null;
  if (desiredAccount === next) return;
  desiredAccount = next;
  const ticket = ++generation;
  const prior = current;
  current = null;
  const closing = prior ? closeOwner(prior) : Promise.resolve();
  // Attach rejection handling immediately; lifecycle work may still be queued.
  const settledClose = closing.then(() => ({ ok: true as const }), () => ({ ok: false as const }));
  publish(next === null ? EMPTY_MESSAGING_SNAPSHOT : {
    accountId: next, status: "opening", conversations: [], currentProjections: null, error: null, revision: 0,
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
        generation: ticket, refreshing: null, refreshAgain: false, authorityVersion: 0, detach: () => undefined };
      current = owner;
      owner.detach = attachResume(owner);
      await reload(owner); // Publish local rows before attempting network work.
      void refreshOwner(owner);
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
  publish({ ...snapshot, currentProjections: null });
  void refreshOwner(owner);
}

export function refreshMessaging(accountId: string): Promise<void> {
  if (!current && desiredAccount === accountId) {
    // Explicit retry may reopen after a recoverable startup failure.
    setMessagingAccount(null);
    setMessagingAccount(accountId);
    return lifecycle;
  }
  return refreshOwner(ownerFor(accountId));
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
  void refreshOwner(owner);
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

export async function sendMessagingText(accountId: string, conversationId: string, peerId: string, body: string): Promise<string> {
  const owner = ownerFor(accountId);
  const id = uuid(crypto.randomUUID());
  await owner.session.send({ id, conversationId: uuid(conversationId), authorId: uuid(accountId), recipientId: uuid(peerId), body });
  assertOwner(owner);
  await reload(owner); // Queued send appears without waiting for connectivity.
  void refreshOwner(owner);
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
  assertOwner(owner); await reload(owner); void refreshOwner(owner);
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
  await refreshOwner(owner);
  assertOwner(owner);
  return id;
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
    if (current === owner && owner.generation === generation) await refreshOwner(owner);
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
    if (current === owner && owner.generation === generation) void refreshOwner(owner);
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
  void refreshOwner(owner);
}

export async function clearMessagingConversation(accountId: string, conversationId: string, throughSequence: number): Promise<void> {
  const owner = ownerFor(accountId);
  invalidateAuthority(owner);
  await owner.session.clearConversation(uuid(conversationId), throughSequence);
  assertOwner(owner);
  await reload(owner);
  void refreshOwner(owner);
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
    if (current === owner && owner.generation === generation) void refreshOwner(owner);
  }
}
