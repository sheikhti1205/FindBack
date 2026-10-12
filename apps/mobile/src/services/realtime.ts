import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient";
import { invalidateFeedCaches } from "../hooks/feedCache";

export type RealtimeEvent =
  | "feed:changed"
  | "post:updated"
  | "post:deleted"
  | "comment:added"
  | "comment:deleted"
  | "reaction:changed"
  | "rating:changed"
  | "notification:added";

type Handler = (payload: Record<string, unknown>) => void;

const listeners = new Map<RealtimeEvent, Set<Handler>>();
const postChannels = new Map<string, RealtimeChannel>();
const desiredPosts = new Set<string>();
let client: SupabaseClient | null = null;
let feedChannel: RealtimeChannel | null = null;
let inboxChannel: RealtimeChannel | null = null;
let boundInboxUser: string | null = null;
let desiredInboxUser: string | null = null;
let ready: Promise<void> = Promise.resolve();
let authUnsubscribe: (() => void) | null = null;

// Reconnect policy: bounded exponential backoff, capped, deduped per channel
// key, and always cancelled by disconnectRealtime(). The first retry waits 1s,
// doubling to a 30s ceiling so a flapping socket never hot-loops.
const RETRY_MAX_DELAY_MS = 30_000;
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryCounts = new Map<string, number>();

/** Status values are a string enum the app treats as plain strings. */
function isSubscribedStatus(status: unknown): boolean {
  return status === "SUBSCRIBED";
}

function isFailedStatus(status: unknown): boolean {
  return status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED";
}

function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

/** Forget a channel's retry state (successful subscribe or explicit leave). */
function clearRetry(key: string): void {
  const timer = retryTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    retryTimers.delete(key);
  }
  retryCounts.delete(key);
}

function clearAllRetries(): void {
  for (const key of Array.from(retryTimers.keys())) clearRetry(key);
}

/** One in-flight reconnect per key; attempts reset on the next SUBSCRIBED. */
function scheduleRetry(key: string, retry: () => void): void {
  if (retryTimers.has(key)) return;
  const attempt = retryCounts.get(key) ?? 0;
  retryCounts.set(key, attempt + 1);
  retryTimers.set(
    key,
    setTimeout(() => {
      retryTimers.delete(key);
      retry();
    }, backoffDelayMs(attempt)),
  );
}

/**
 * Attach wire-event handlers to a private channel. The caller stores the
 * channel in its slot BEFORE subscribing: a subscribe() status callback can
 * fire synchronously, and a failure must be able to clear the slot it just
 * filled.
 */
function bindHandlers(channel: RealtimeChannel, bindings: Array<[string, RealtimeEvent]>): RealtimeChannel {
  for (const [wireEvent, appEvent] of bindings) {
    channel.on("broadcast", { event: wireEvent }, (message) => {
      dispatch(appEvent, (message?.payload ?? {}) as Record<string, unknown>);
    });
  }
  return channel;
}

function dispatch(event: RealtimeEvent, payload: Record<string, unknown>): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) handler(payload);
}

/**
 * Lazily create the client and keep the Realtime socket's auth in step with the
 * session. Private-channel RLS is checked against that token, so channels must
 * only be opened after this resolves (the `ready` gate below). The token owner
 * stays the auth module: this listener only mirrors its changes into Realtime
 * and tears down user-scoped sockets when the session goes away.
 */
function ensureClient(): SupabaseClient | null {
  // The cached client is only reusable while its auth mirror is still
  // attached. Sign-out tears the mirror down, and a first attach can fail
  // after the client is cached; either way an early-return here would leave
  // a long-lived socket on the access token it was opened with — a stale
  // token for the rest of the process (SIGNED_OUT → sign-in never rebinds).
  if (client && authUnsubscribe) return client;
  if (!client) {
    try {
      client = getSupabase();
    } catch {
      return null;
    }
  }
  const c = client;
  // Mirror every auth change (TOKEN_REFRESHED included) into Realtime so a
  // long-lived socket never keeps using the access token it was opened with.
  authUnsubscribe = c.auth.onAuthStateChange((_event, session) => {
    if (client !== c) return;
    if (session) {
      c.realtime.setAuth(session.access_token);
      return;
    }
    // SIGNED_OUT: the remaining channels are scoped to the dead user's RLS.
    disconnectRealtime();
  }).data.subscription.unsubscribe;
  ready = c.auth
    .getSession()
    .then(({ data }) => {
      if (data.session) c.realtime.setAuth(data.session.access_token);
    })
    .catch(() => undefined);
  return c;
}

/** Open the authenticated Realtime connection. Idempotent and safe on every auth change. */
export function connectRealtime(): void {
  const c = ensureClient();
  if (!c || feedChannel) return;
void ready.then(() => {
      if (client !== c || feedChannel) return;
      // The feed channel carries every post/comment/reaction change. A real
      // INSERT is a new post (increments the pill). UPDATE/DELETE mark feeds
      // dirty so back-nav from Detail never restores stale/deleted cards.
      // COMMENT_CHANGE/REACTION_CHANGE/RATING_CHANGE are generic updates only.
      const channel = c.channel("feed", { config: { private: true } });
      channel.on("broadcast", { event: "post:changed" }, (message) => {
        const payload = (message?.payload ?? {}) as Record<string, unknown>;
        const change = String(payload.change ?? payload.op ?? "").toUpperCase();
        if (change === "INSERT" || change === "UPDATE" || change === "DELETE") {
          invalidateFeedCaches();
        }
        dispatch("feed:changed", payload);
      });
      // A dropped feed subscription used to stay dead for the rest of the
      // session. The slot is filled BEFORE subscribing so a synchronous
      // CHANNEL_ERROR can clear it; the retry reconnects with backoff.
      feedChannel = channel;
      channel.subscribe((status: unknown) => {
        if (isSubscribedStatus(status)) {
          clearRetry("feed");
          return;
        }
        if (!isFailedStatus(status)) return;
        if (feedChannel === channel) {
          feedChannel = null;
          void c.removeChannel(channel);
        }
        if (client === c) scheduleRetry("feed", () => connectRealtime());
      });
    });
}

/** Tear down every channel (logout/unmount). The listener registry is kept. */
export function disconnectRealtime(): void {
  desiredPosts.clear();
  desiredInboxUser = null;
  boundInboxUser = null;
  clearAllRetries();
  if (authUnsubscribe) {
    authUnsubscribe();
    authUnsubscribe = null;
  }
  if (!client) return;
  if (feedChannel) {
    void client.removeChannel(feedChannel);
    feedChannel = null;
  }
  if (inboxChannel) {
    void client.removeChannel(inboxChannel);
    inboxChannel = null;
  }
  for (const [postId, channel] of postChannels) {
    void client.removeChannel(channel);
    postChannels.delete(postId);
  }
  client = null;
  ready = Promise.resolve();
}

/** Subscribe to an app-level realtime event; returns an unsubscribe function. */
export function onRealtime(event: RealtimeEvent, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => {
    listeners.get(event)?.delete(handler);
  };
}

/** Subscribe to a post's private topic so its live events arrive. */
export function joinPostRoom(postId: string): void {
  desiredPosts.add(postId);
  const c = ensureClient();
  if (!c) return;
  void ready.then(() => {
    if (client !== c || !desiredPosts.has(postId) || postChannels.has(postId)) return;
    const key = `post:${postId}`;
    const channel = bindHandlers(c.channel(key, { config: { private: true } }), [
      ["post:updated", "post:updated"],
      ["post:deleted", "post:deleted"],
      ["comment:added", "comment:added"],
      ["comment:deleted", "comment:deleted"],
      ["reaction:changed", "reaction:changed"],
      ["rating:changed", "rating:changed"],
    ]);
    // Slot first (a synchronous subscribe failure must be able to clear it).
    postChannels.set(postId, channel);
    channel.subscribe((status: unknown) => {
      if (isSubscribedStatus(status)) {
        clearRetry(key);
        return;
      }
      if (!isFailedStatus(status)) return;
      if (postChannels.get(postId) === channel) {
        postChannels.delete(postId);
        void c.removeChannel(channel);
      }
      if (client === c && desiredPosts.has(postId)) scheduleRetry(key, () => joinPostRoom(postId));
    });
  });
}

export function leavePostRoom(postId: string): void {
  desiredPosts.delete(postId);
  clearRetry(`post:${postId}`);
  const channel = postChannels.get(postId);
  if (!channel || !client) return;
  void client.removeChannel(channel);
  postChannels.delete(postId);
}

/**
 * Subscribe to the signed-in user's private inbox topic. The server broadcasts
 * a data-free signal on new notifications; consumers refetch their own inbox.
 * A channel bound to another account is dropped first so an account switch can
 * never keep listening on the previous user's topic.
 */
export function joinInboxRoom(userId: string): void {
  const c = ensureClient();
  if (!c) return;
  desiredInboxUser = userId;
  void ready.then(() => {
    if (client !== c || desiredInboxUser !== userId) return;
    if (inboxChannel && boundInboxUser !== userId) {
      clearRetry("inbox");
      void c.removeChannel(inboxChannel);
      inboxChannel = null;
      boundInboxUser = null;
    }
    if (inboxChannel) return;
    const channel = bindHandlers(c.channel(`notification:${userId}`, { config: { private: true } }), [
      ["notification:added", "notification:added"],
    ]);
    // Slot first (a synchronous subscribe failure must be able to clear it).
    inboxChannel = channel;
    boundInboxUser = userId;
    channel.subscribe((status: unknown) => {
      if (isSubscribedStatus(status)) {
        clearRetry("inbox");
        return;
      }
      if (!isFailedStatus(status)) return;
      if (inboxChannel === channel) {
        inboxChannel = null;
        boundInboxUser = null;
        void c.removeChannel(channel);
      }
      if (client === c && desiredInboxUser === userId) {
        scheduleRetry("inbox", () => joinInboxRoom(userId));
      }
    });
  });
}

export function leaveInboxRoom(): void {
  desiredInboxUser = null;
  boundInboxUser = null;
  clearRetry("inbox");
  if (!client || !inboxChannel) return;
  void client.removeChannel(inboxChannel);
  inboxChannel = null;
}
