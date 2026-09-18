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
  | "rating:changed";

type Handler = (payload: Record<string, unknown>) => void;

const listeners = new Map<RealtimeEvent, Set<Handler>>();
const postChannels = new Map<string, RealtimeChannel>();
const desiredPosts = new Set<string>();
let client: SupabaseClient | null = null;
let feedChannel: RealtimeChannel | null = null;
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
    // The feed channel carries every post/comment/reaction change. Only a real
    // INSERT is a new post, so only that invalidates cached feeds (even while
    // Home is unmounted) before the app-level event is dispatched.
    const channel = c.channel("feed", { config: { private: true } });
    channel.on("broadcast", { event: "post:changed" }, (message) => {
      const payload = (message?.payload ?? {}) as Record<string, unknown>;
      if (String(payload.op ?? "").toUpperCase() === "INSERT") invalidateFeedCaches();
      dispatch("feed:changed", payload);
    });
    channel.subscribe();
    feedChannel = channel;
  });
}

/** Tear down every channel (logout/unmount). The listener registry is kept. */
export function disconnectRealtime(): void {
  desiredPosts.clear();
  if (!client) return;
  if (feedChannel) {
    void client.removeChannel(feedChannel);
    feedChannel = null;
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
