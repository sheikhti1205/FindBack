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
let desiredInboxUser: string | null = null;
let ready: Promise<void> = Promise.resolve();

/** Wire a private Supabase channel, translating DB event names to app events. */
function bind(channel: RealtimeChannel, bindings: Array<[string, RealtimeEvent]>): RealtimeChannel {
  for (const [wireEvent, appEvent] of bindings) {
    channel.on("broadcast", { event: wireEvent }, (message) => {
      dispatch(appEvent, (message?.payload ?? {}) as Record<string, unknown>);
    });
  }
  channel.subscribe();
  return channel;
}

function dispatch(event: RealtimeEvent, payload: Record<string, unknown>): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of set) handler(payload);
}

/**
 * Lazily create the client and push the current session's access token into the
 * Realtime socket. Private-channel RLS is checked against that token, so channels
 * must only be opened after this resolves (the `ready` gate below).
 */
function ensureClient(): SupabaseClient | null {
  if (client) return client;
  try {
    client = getSupabase();
  } catch {
    return null;
  }
  const c = client;
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
      channel.subscribe();
      feedChannel = channel;
    });
}

/** Tear down every channel (logout/unmount). The listener registry is kept. */
export function disconnectRealtime(): void {
  desiredPosts.clear();
  desiredInboxUser = null;
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
    const channel = bind(c.channel(`post:${postId}`, { config: { private: true } }), [
      ["post:updated", "post:updated"],
      ["post:deleted", "post:deleted"],
      ["comment:added", "comment:added"],
      ["comment:deleted", "comment:deleted"],
      ["reaction:changed", "reaction:changed"],
      ["rating:changed", "rating:changed"],
    ]);
    postChannels.set(postId, channel);
  });
}

export function leavePostRoom(postId: string): void {
  desiredPosts.delete(postId);
  const channel = postChannels.get(postId);
  if (!channel || !client) return;
  void client.removeChannel(channel);
  postChannels.delete(postId);
}

/**
 * Subscribe to the signed-in user's private inbox topic. The server broadcasts
 * a data-free signal on new notifications; consumers refetch their own inbox.
 */
export function joinInboxRoom(userId: string): void {
  const c = ensureClient();
  if (!c) return;
  desiredInboxUser = userId;
  void ready.then(() => {
    if (client !== c || desiredInboxUser !== userId || inboxChannel) return;
    inboxChannel = bind(c.channel(`notification:${userId}`, { config: { private: true } }), [
      ["notification:added", "notification:added"],
    ]);
  });
}

export function leaveInboxRoom(): void {
  desiredInboxUser = null;
  if (!client || !inboxChannel) return;
  void client.removeChannel(inboxChannel);
  inboxChannel = null;
}
