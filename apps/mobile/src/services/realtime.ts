import { io, type Socket } from "socket.io-client";
import { apiBase, getToken } from "./api";

type EventName =
  | "feed:changed"
  | "post:updated"
  | "post:deleted"
  | "comment:added"
  | "comment:deleted"
  | "reaction:changed"
  | "rating:changed";

type Handler = (payload: Record<string, unknown>) => void;

let socket: Socket | null = null;
const listeners = new Map<EventName, Set<Handler>>();

/**
 * Socket.IO handshake auth. A function (not a fixed object) so every
 * (re)connection attempt reads the latest stored access token — a reconnect
 * after a token refresh does not authenticate with a stale token.
 */
export function socketAuth(): (cb: (data: { token: string }) => void) => void {
  return (cb) => cb({ token: getToken() ?? "" });
}

/** Connect (or reconnect) the Socket.IO transport with the current token. */
export function connectRealtime(): void {
  if (!getToken()) return;
  const auth = socketAuth();
  if (socket) {
    socket.auth = auth;
    return;
  }
  socket = io(apiBase(), {
    auth,
    transports: ["websocket"],
    reconnection: true,
  });
  for (const [event, set] of listeners) {
    for (const handler of set) {
      socket.on(event, handler as (payload: unknown) => void);
    }
  }
}

export function disconnectRealtime(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Subscribe to a realtime event; returns an unsubscribe function. */
export function onRealtime(event: EventName, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  socket?.on(event, handler as (payload: unknown) => void);
  return () => {
    listeners.get(event)?.delete(handler);
    socket?.off(event, handler as (payload: unknown) => void);
  };
}

/** Join the room for a post so its live events arrive. */
export function joinPostRoom(postId: string): void {
  socket?.emit("join", postId);
}

export function leavePostRoom(postId: string): void {
  socket?.emit("leave", postId);
}
