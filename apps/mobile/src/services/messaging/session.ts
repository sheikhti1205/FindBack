import type { HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope } from "./history";
import { copyMessage, positiveSequence, uuid } from "./validation";
import { copyConversationProjection, type ConversationProjection } from "./conversationIndex";
import { copyStateEnvelope, type StateChangeEnvelope } from "./stateChanges";

type ChatAction = "REGISTER" | "CREATE" | "ACCEPT" | "END" | "BLOCK" | "SEND" | "SYNC" | "ACK" | "RECEIPT_VIEW" | "RECEIPT_OBSERVE" | "RECEIPTS" | "VIEWS" | "PRIVATE" | "PREFERENCES" | "CONTACT_MODE"
  | "STATE_SYNC" | "STATE_ACK" | "UNSEND" | "DELETE_FOR_ME" | "CLEAR_FOR_ME";
export interface MessagingPreferences { openMessages: boolean; readReceipts: boolean }
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
  let stateTail: Promise<unknown> = Promise.resolve();
  const assertOpen = () => { if (controller.signal.aborted) throw new Error("Messaging session closed"); };
  const call = async (action: ChatAction, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    assertOpen();
    const request = new AbortController();
    const abort = () => request.abort();
    controller.signal.addEventListener("abort", abort);
    signal?.addEventListener("abort", abort);
    try {
      if (controller.signal.aborted || signal?.aborted) throw new Error("Messaging request closed");
      const value = await rpc({ ...scope, action, args, signal: request.signal });
      assertOpen();
      if (request.signal.aborted) throw new Error("Messaging request closed");
      return value;
    } finally {
      controller.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  };
  const syncState = (): Promise<void> => {
    const run = async () => {
      assertOpen();
      let cursor = await history.getStateCursor();
      // Retry an ACK lost after a prior local commit. Server ACK state is never
      // used to skip local application after reinstall/lost history.
      if (cursor) await call("STATE_ACK", { ...cursor });
      for (let page = 0; page < 100; page++) {
        const response = await call("STATE_SYNC", { afterSequence: cursor?.sequence ?? 0 });
        if (!Array.isArray(response) || response.length > 100) throw new Error("Invalid messaging state batch");
        const envelopes = response.map((entry) => copyStateEnvelope(object(entry) as unknown as StateChangeEnvelope, scope));
        let previous = cursor?.sequence ?? 0;
        for (const envelope of envelopes) {
          if (envelope.change.sequence <= previous) throw new Error("Invalid messaging state order");
          previous = envelope.change.sequence;
        }
        for (const envelope of envelopes) {
          assertOpen();
          cursor = await history.applyStateChange(envelope);
          assertOpen();
          await call("STATE_ACK", { ...cursor });
        }
        if (envelopes.length < 100) return;
      }
      throw new Error("Message state sync is incomplete. Try again.");
    };
    const next = stateTail.then(run);
    stateTail = next.catch(() => undefined);
    return next;
  };
  const sync = async () => {
    await syncState();
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
    return envelopes.length;
  };
  const refreshConversations = async (): Promise<ConversationProjection[]> => {
    const projections: ConversationProjection[] = [];
    let afterId: string | null = null;
    // Bounded per refresh; an incomplete page set is not presented as current.
    for (let page = 0; page < 100; page++) {
      const response = await call("VIEWS", { afterId });
      if (!Array.isArray(response) || response.length > 100) throw new Error("Invalid conversation batch");
      const batch = response.map((entry) => copyConversationProjection(object(entry) as unknown as ConversationProjection));
      let previous: string | null = afterId;
      for (const projection of batch) {
        if (projection.peerId === scope.accountId || (previous !== null && projection.conversationId <= previous)) {
          throw new Error("Invalid conversation scope or ordering");
        }
        previous = projection.conversationId;
      }
      // Validate the whole page before persisting any row, and scope-fence each
      // write so late results cannot repopulate a signed-out account's UI.
      for (const projection of batch) {
        assertOpen();
        await history.cacheConversation(projection);
        assertOpen();
      }
      projections.push(...batch);
      if (batch.length < 100) return projections;
      const last = batch[batch.length - 1];
      if (!last) throw new Error("Invalid conversation page");
      afterId = last.conversationId;
    }
    throw new Error("Conversation sync is incomplete. Try again.");
  };
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    const run = async () => {
      assertOpen();
      await syncState();
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
    async setPrivateState(conversationId: string, operation: "HIDE" | "UNHIDE" | "DECLINE") {
      await call("PRIVATE", { conversationId: uuid(conversationId), operation });
    },
    async removeMessage(conversationId: string, messageId: string, unsend: boolean) {
      uuid(await call(unsend ? "UNSEND" : "DELETE_FOR_ME", { conversationId: uuid(conversationId), messageId: uuid(messageId) }) as string);
      // Do not apply the mutation response out of order and skip intervening
      // state from another own device. Fetch from the durable cursor instead.
      await syncState();
    },
    async clearConversation(conversationId: string, throughSequence: number) {
      uuid(await call("CLEAR_FOR_ME", { conversationId: uuid(conversationId), throughSequence: positiveSequence(throughSequence) }) as string);
      await syncState();
    },
    async setReadReceipts(enabled: boolean) { await call("RECEIPTS", { enabled }); },
    async setOpenMessages(enabled: boolean) { await call("CONTACT_MODE", { enabled }); },
    async getPreferences(): Promise<MessagingPreferences> {
      const value = object(await call("PREFERENCES"));
      if (typeof value.openMessages !== "boolean" || typeof value.readReceipts !== "boolean") {
        throw new Error("Invalid chat preferences");
      }
      return { openMessages: value.openMessages, readReceipts: value.readReceipts };
    },
    async receiptView(conversationId: string, messageIds: string[], signal?: AbortSignal) {
      if (messageIds.length > 100 || new Set(messageIds).size !== messageIds.length) throw new Error("Invalid receipt request");
      const ids = messageIds.map(uuid);
      const value = object(await call("RECEIPT_VIEW", { conversationId: uuid(conversationId), messageIds: ids }, signal));
      if ((value.context !== null && (typeof value.context !== "string" || !/^[0-9a-f]{64}$/.test(value.context)))
        || !Array.isArray(value.readIds) || value.readIds.length > ids.length) throw new Error("Invalid receipt response");
      const readIds = value.readIds.map((id: unknown) => uuid(id as string));
      if (new Set(readIds).size !== readIds.length || readIds.some((id: string) => !ids.includes(id))
        || (value.context === null && readIds.length > 0)) throw new Error("Invalid receipt response");
      return { context: value.context as string | null, readIds };
    },
    async observeReceipt(conversationId: string, context: string, messageId: string, signal?: AbortSignal) {
      if (!/^[0-9a-f]{64}$/.test(context)) throw new Error("Invalid receipt context");
      const value = await call("RECEIPT_OBSERVE", { conversationId: uuid(conversationId), context, messageId: uuid(messageId) }, signal);
      if (typeof value !== "boolean") throw new Error("Invalid receipt response");
      return value;
    },
    async send(value: HumanMessage) {
      assertOpen();
      const message = copyMessage(value);
      if (message.authorId !== scope.accountId) throw new Error("Invalid messaging author");
      await history.enqueueOutgoing(message);
      assertOpen();
    },
    sync, syncState, flush, refreshConversations,
    close() { controller.abort(); return Promise.resolve(history.close()); },
  };
}
