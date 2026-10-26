import type { HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope } from "./history";
import { copyMessage, positiveSequence, uuid } from "./validation";

type ChatAction = "REGISTER" | "CREATE" | "ACCEPT" | "END" | "BLOCK" | "SEND" | "SYNC" | "ACK" | "READ" | "RECEIPTS";
export type MessagingRpc = (input: MessagingScope & {
  action: ChatAction;
  args: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid messaging response");
  return value as Record<string, unknown>;
}

/** Shape/scope validation comes before the durable adapter's own validation. */
function mailbox(value: unknown, scope: MessagingScope): MailboxEnvelope {
  const row = object(value);
  const event = object(row.event);
  if (row.accountId !== scope.accountId || row.deviceId !== scope.deviceId || event.kind !== "TEXT") {
    throw new Error("Invalid messaging scope");
  }
  const message = copyMessage(object(event.message) as unknown as HumanMessage);
  if (message.authorId !== scope.accountId && message.recipientId !== scope.accountId) throw new Error("Invalid messaging participant");
  return {
    ...scope, mailboxId: uuid(row.mailboxId as string),
    event: { kind: "TEXT", eventId: uuid(event.eventId as string), sequence: positiveSequence(event.sequence), message },
  };
}

/**
 * One account/installation lifetime. Session owner MUST close on sign-out/switch.
 * Reuses either canonical durable adapter; never ACKs a fetch or an in-memory copy.
 * No timers/presence/push payloads are treated as message authority.
 */
export function createMessagingSession(identity: MessagingScope, history: MessagingHistory, rpc: MessagingRpc) {
  const scope = Object.freeze({ accountId: uuid(identity.accountId), deviceId: uuid(identity.deviceId) });
  const controller = new AbortController();
  let flushing: Promise<void> | null = null;
  const assertOpen = () => { if (controller.signal.aborted) throw new Error("Messaging session closed"); };
  const call = async (action: ChatAction, args: Record<string, unknown> = {}) => {
    assertOpen();
    const value = await rpc({ ...scope, action, args, signal: controller.signal });
    assertOpen();
    return value;
  };
  const sync = async () => {
    const response = await call("SYNC");
    if (!Array.isArray(response) || response.length > 100) throw new Error("Invalid messaging batch");
    // Reject a malformed batch before applying any of its entries.
    const envelopes = response.map((entry) => mailbox(entry, scope));
    for (const envelope of envelopes) {
      assertOpen();
      await history.persistInboundAndAck(envelope, async (receipt) => {
        assertOpen();
        await call("ACK", { mailboxId: receipt.mailboxId });
      });
    }
  };
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    const run = async () => {
      assertOpen();
      while (true) {
        const attempt = await history.claimNextOutgoing();
        if (!attempt) break;
        try {
          const message = copyMessage(attempt.message);
          if (message.authorId !== scope.accountId) throw new Error("Invalid messaging author");
          const accepted = await call("SEND", {
            conversationId: message.conversationId, recipientId: message.recipientId,
            messageId: message.id, body: message.body,
          });
          if (accepted !== message.id) throw new Error("Invalid messaging acknowledgement");
        } catch (error) {
          await history.failOutgoing(attempt);
          throw error;
        }
        // Echo persistence, not the HTTP result, removes the durable outbox entry.
        await sync();
      }
      // A prior HTTP send can succeed before persistence/ACK fails. Retry its
      // mailbox even while the durable outbox lease remains active.
      await sync();
    };
    flushing = run().finally(() => { flushing = null; });
    return flushing;
  };
  return {
    async start(platform: "web" | "android" | "ios") { await call("REGISTER", { platform }); },
    async request(otherId: string) { return uuid(await call("CREATE", { otherId: uuid(otherId) }) as string); },
    async accept(conversationId: string) { await call("ACCEPT", { conversationId: uuid(conversationId) }); },
    async end(conversationId: string) { await call("END", { conversationId: uuid(conversationId) }); },
    async block(conversationId: string) { await call("BLOCK", { conversationId: uuid(conversationId) }); },
    async setReadReceipts(enabled: boolean) { await call("RECEIPTS", { enabled }); },
    async markRead(messageId: string) { await call("READ", { messageId: uuid(messageId) }); },
    async send(value: HumanMessage) {
      assertOpen();
      const message = copyMessage(value);
      if (message.authorId !== scope.accountId) throw new Error("Invalid messaging author");
      await history.enqueueOutgoing(message);
      assertOpen();
    },
    sync, flush,
    close() { controller.abort(); history.close(); },
  };
}
