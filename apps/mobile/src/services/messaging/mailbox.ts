import type { HumanMessage, MailboxEnvelope, MessagingScope } from "./history";
import { copyReceivedMessage, positiveSequence, uuid } from "./validation";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid messaging response");
  return value as Record<string, unknown>;
}

/** Shared shape/scope validator for ordinary delivery and bounded prefix repair. */
export function copyMailboxEnvelope(value: unknown, scope: MessagingScope): MailboxEnvelope {
  const row = object(value), event = object(row.event);
  if (row.accountId !== scope.accountId || row.deviceId !== scope.deviceId || event.kind !== "TEXT") throw new Error("Invalid messaging scope");
  const message = copyReceivedMessage(object(event.message) as unknown as HumanMessage);
  if (message.authorId !== scope.accountId && message.recipientId !== scope.accountId) throw new Error("Invalid messaging participant");
  return { ...scope, mailboxId: uuid(row.mailboxId as string), event: {
    kind: "TEXT", eventId: uuid(event.eventId as string), sequence: positiveSequence(event.sequence), message,
  } };
}
