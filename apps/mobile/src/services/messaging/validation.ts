/** Shared validation for human messaging storage adapters. */
import type { HumanMessage, MediaAttachment, MessageType } from "./history";
import type { ConversationProjection } from "./conversationIndex";
import { copyMediaMetadata, MEDIA_STATES, type MediaMime, type MediaState } from "./media";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Storage-input bound only; not a product decision about message limits. */
export const MAX_BODY_UNITS = 100_000;

/** Offline eligibility only; the server re-authorizes every remote operation. */
export function cachedMediaAllowed(projection: ConversationProjection | undefined): boolean {
  return projection?.mode === "CONNECTED" && !projection.ownBlocked;
}

export function uuid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid messaging UUID");
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export interface CopyMessageOptions {
  /**
   * A media message may carry no caption: `""` is then a legitimate body, not
   * the suppression sentinel. Text-only sends keep the strict rule.
   */
  allowEmptyBody?: boolean;
}

export function copyMessage(value: HumanMessage, options: CopyMessageOptions = {}): HumanMessage {
  const message = copyReceivedMessage(value, options);
  if (message.messageType === "MEDIA") throw new Error("Invalid messaging type");
  return { ...message, messageType: "TEXT" };
}

/** Authorized mailbox/history data: missing legacy classification stays unknown. */
export function copyReceivedMessage(value: HumanMessage, options: CopyMessageOptions = { allowEmptyBody: true }): HumanMessage {
  const messageType = value?.messageType;
  if (messageType !== undefined && messageType !== "TEXT" && messageType !== "MEDIA") {
    throw new Error("Invalid messaging type");
  }
  if (!value || typeof value.body !== "string" || value.body.length > MAX_BODY_UNITS
    || ((!options.allowEmptyBody || messageType === "TEXT") && !value.body.trim())
    || (value.body !== "" && !value.body.trim())) {
    throw new Error("Invalid messaging text");
  }
  // A NUL byte makes SQLite's length()/text handling disagree with JS, so it is
  // rejected at the shared boundary instead of failing later inside the adapter.
  if (value.body.includes("\u0000")) throw new Error("Invalid messaging text");
  const message = {
    id: uuid(value.id), conversationId: uuid(value.conversationId),
    authorId: uuid(value.authorId), recipientId: uuid(value.recipientId), body: value.body,
    ...(messageType ? { messageType } : {}),
  };
  if (message.authorId === message.recipientId) throw new Error("Invalid messaging participants");
  return message;
}

/**
 * An image-only message has no caption, so `""` is valid here — but it still
 * means "no caption", never "suppressed". A whitespace-only body is not a
 * caption either; it would render as a blank bubble, so it is refused.
 */
export function copyMediaMessage(value: HumanMessage): HumanMessage {
  if (value?.messageType !== undefined && value.messageType !== "MEDIA") throw new Error("Invalid messaging type");
  const message = copyReceivedMessage({ ...value, messageType: "MEDIA" });
  if (message.body !== "" && !message.body.trim()) throw new Error("Invalid messaging text");
  return message;
}

export function sameMessage(a: HumanMessage, b: HumanMessage): boolean {
  return a.id === b.id && a.conversationId === b.conversationId && a.authorId === b.authorId
    && a.recipientId === b.recipientId && a.body === b.body && compatibleMessageType(a.messageType, b.messageType);
}

/** Unknown legacy state may gain authority; two known contradictory types cannot merge. */
export function compatibleMessageType(a: MessageType | null | undefined, b: MessageType | null | undefined): boolean {
  return a == null || b == null || a === b;
}

export function positiveSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid messaging sequence");
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${what}`);
  }
  return value;
}

/**
 * The one set of attachment rules. SQLite restates them as CHECK constraints;
 * IndexedDB has no constraints at all, so this function is its only enforcement.
 * Neither adapter may write a record that has not passed through here.
 *
 * The lease rule is exact: `token` and `leaseUntil` are present if and only if
 * `state === "UPLOADING"`. A stale token therefore cannot survive a state
 * transition, and a `READY` record can never look claimable.
 */
export function copyMediaAttachment(value: unknown): MediaAttachment {
  const input = value as Partial<MediaAttachment> | null | undefined;
  if (!input || typeof input !== "object") throw new Error("Invalid media attachment");
  // Identity, digest, MIME, size, dimensions and expiry share one validator with
  // the transport layer; a second copy of those bounds would drift.
  const metadata = copyMediaMetadata(input);
  if (typeof input.state !== "string" || !(MEDIA_STATES as readonly string[]).includes(input.state)) {
    throw new Error("Invalid media state");
  }
  const state = input.state as MediaState;
  if (metadata.direction === "IN") {
    // Inbound only exists once bytes arrived; there is no local upload queue.
    if (state !== "AWAITING_ACK" && state !== "READY" && state !== "EVICTED") {
      throw new Error("Invalid media state for direction");
    }
    // Inbound metadata arrived with trusted delivery metadata, so the retention
    // boundary is known. Only an outbound record may still be waiting for it.
    if (metadata.expiresAt === null) throw new Error("Invalid media expiry");
  }
  const attempts = boundedInteger(input.attempts, 0, Number.MAX_SAFE_INTEGER, "media attempts");
  const lastAccessAt = boundedInteger(input.lastAccessAt, 0, Number.MAX_SAFE_INTEGER, "media access time");
  const leased = state === "UPLOADING";
  const hasToken = input.token !== undefined && input.token !== null;
  const hasLease = input.leaseUntil !== undefined && input.leaseUntil !== null;
  if (leased ? !hasToken || !hasLease : hasToken || hasLease) throw new Error("Invalid media lease");
  if (!leased) return { ...metadata, state, attempts, lastAccessAt };
  return {
    ...metadata,
    state,
    attempts,
    lastAccessAt,
    token: uuid(input.token as string),
    leaseUntil: boundedInteger(input.leaseUntil, 1, Number.MAX_SAFE_INTEGER, "media lease"),
  };
}

/**
 * The container signature of the bytes themselves. A MIME claim is metadata; it
 * is only true if the content agrees, so the inbound enforcement point checks
 * both instead of trusting the caller's label.
 */
export function sniffMediaMime(bytes: unknown): MediaMime | null {
  if (!(bytes instanceof ArrayBuffer)) throw new Error("Invalid media bytes");
  const view = new Uint8Array(bytes);
  const starts = (offset: number, signature: readonly number[]) => view.length >= offset + signature.length
    && signature.every((byte, index) => view[offset + index] === byte);
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}
