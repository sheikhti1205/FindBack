/** Shared validation for human messaging storage adapters. */
import type { HumanMessage } from "./history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Storage-input bound only; not a product decision about message limits. */
export const MAX_BODY_UNITS = 100_000;

export function uuid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid messaging UUID");
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function copyMessage(value: HumanMessage): HumanMessage {
  if (!value || typeof value.body !== "string" || !value.body.trim() || value.body.length > MAX_BODY_UNITS) {
    throw new Error("Invalid messaging text");
  }
  // A NUL byte makes SQLite's length()/text handling disagree with JS, so it is
  // rejected at the shared boundary instead of failing later inside the adapter.
  if (value.body.includes("\u0000")) throw new Error("Invalid messaging text");
  const message = {
    id: uuid(value.id), conversationId: uuid(value.conversationId),
    authorId: uuid(value.authorId), recipientId: uuid(value.recipientId), body: value.body,
  };
  if (message.authorId === message.recipientId) throw new Error("Invalid messaging participants");
  return message;
}

export function sameMessage(a: HumanMessage, b: HumanMessage): boolean {
  return a.id === b.id && a.conversationId === b.conversationId && a.authorId === b.authorId
    && a.recipientId === b.recipientId && a.body === b.body;
}

export function positiveSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid messaging sequence");
  }
  return value;
}
