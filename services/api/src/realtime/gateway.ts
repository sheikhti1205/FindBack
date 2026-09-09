/**
 * RealtimeGateway — in-process bus the domain services write to.
 *
 * The Socket.IO transport subscribes once and forwards events to connected
 * clients. Swapping in Supabase Realtime / Firebase listeners later only
 * requires replacing the subscriber inside `realtime/socket.ts`, not the
 * domain services.
 */

export type GatewayEvent =
  | "feed:changed"
  | "post:updated"
  | "post:deleted"
  | "comment:added"
  | "comment:deleted"
  | "reaction:changed"
  | "rating:changed";

export interface GatewayEventPayloads {
  "feed:changed": { postId?: string };
  "post:updated": { postId: string };
  "post:deleted": { postId: string };
  "comment:added": { postId: string; comment: unknown };
  "comment:deleted": { postId: string; commentId: string };
  "reaction:changed": {
    postId: string;
    likeCount: number;
    dislikeCount: number;
  };
  "rating:changed": { postId: string; ratingAvg: number | null; ratingCount: number };
}

type Listener = (event: GatewayEvent, payload: GatewayEventPayloads[GatewayEvent]) => void;

const listeners = new Set<Listener>();

export function onGatewayEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitGateway<K extends GatewayEvent>(
  event: K,
  payload: GatewayEventPayloads[K],
): void {
  for (const listener of listeners) listener(event, payload);
}
