import type { HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope } from "./history";
import { copyMediaMessage, copyMessage, copyReceivedMessage, positiveSequence, uuid } from "./validation";
import { copyConversationProjection, type ConversationProjection } from "./conversationIndex";
import { copyStateEnvelope, type StateChangeEnvelope } from "./stateChanges";
import { copyMediaMetadata, sameMediaIdentity, type MediaMetadata } from "./media";
import type { createMediaTransport, MediaDelivery } from "./mediaTransport";
import { PhotoUnavailableError } from "./mediaTransport";

type MediaTransportFactory = (scope: MessagingScope, signal: AbortSignal) => ReturnType<typeof createMediaTransport>;

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
  // The authorized TEXT envelope also carries optional media captions. This
  // does not relax local plain-text admission in send().
  const message = copyReceivedMessage(object(event.message) as unknown as HumanMessage);
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
export function createMessagingSession(identity: MessagingScope, history: MessagingHistory, rpc: MessagingRpc,
  mediaFactory?: MediaTransportFactory) {
  const scope = Object.freeze({ accountId: uuid(identity.accountId), deviceId: uuid(identity.deviceId) });
  const controller = new AbortController();
  let flushing: Promise<void> | null = null;
  let stateTail: Promise<unknown> = Promise.resolve();
  const assertOpen = () => { if (controller.signal.aborted) throw new Error("Messaging session closed"); };
  const mediaUnavailable = () => new Error("Photo could not sync. Try again.");
  let mediaEpoch = 0, mediaMutations = 0, mediaPaused = false;
  let mediaController = new AbortController();
  let mediaTransport: ReturnType<typeof createMediaTransport> | undefined;
  let mediaFlushing: Promise<void> | null = null, mediaSyncing: Promise<void> | null = null;
  function mediaContext() {
    assertOpen();
    if (!mediaFactory || mediaPaused) throw mediaUnavailable();
    if (mediaController.signal.aborted) mediaController = new AbortController();
    mediaTransport ??= mediaFactory(scope, mediaController.signal);
    const epoch = mediaEpoch;
    return { transport: mediaTransport, live: () => {
      assertOpen();
      if (epoch !== mediaEpoch || mediaPaused || mediaController.signal.aborted) throw mediaUnavailable();
    } };
  }
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
  // Invalidate at user intent, before the network await. No late media attempt
  // may resume through an end/block/erase, even if that mutation itself fails.
  const withMediaMutation = async <T>(work: () => Promise<T>): Promise<T> => {
    assertOpen(); mediaEpoch++; mediaPaused = true; mediaMutations++;
    mediaController.abort(); mediaTransport = undefined;
    try { return await work(); }
    finally { mediaMutations--; }
  };
  const mediaMutation = (action: ChatAction, args: Record<string, unknown>) =>
    withMediaMutation(() => call(action, args));
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
    const epoch = mediaEpoch;
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
      if (batch.length < 100) {
        if (epoch === mediaEpoch && mediaMutations === 0) mediaPaused = false;
        return projections;
      }
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
          const hasMedia = attempt.message.messageType === "MEDIA";
          if (!attempt.message.messageType) throw new Error("Message classification unavailable");
          const message = hasMedia ? copyMediaMessage(attempt.message) : copyMessage(attempt.message);
          if (hasMedia) {
            mediaContext().live();
            const attachments = await history.listMedia(message.conversationId);
            if (!attachments.some((row) => row.messageId === message.id)) throw new Error("Photo unavailable");
          }
          if (message.authorId !== scope.accountId) throw new Error("Invalid messaging author");
          // A local erase can win after the claim, removing both parent visibility
          // and attachment metadata. Never downgrade its captured caption to TEXT.
          const live = await history.getMessage(message.id);
          assertOpen();
          if (!live || live.server || live.unsentAt !== undefined || live.messageType !== message.messageType) throw new Error("Message is no longer pending");
          if (hasMedia) mediaContext().live();
          const accepted = await call("SEND", {
            conversationId: message.conversationId, recipientId: message.recipientId,
            messageId: message.id, body: message.body,
            ...(hasMedia ? { messageType: "MEDIA" } : {}),
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

  const flushMedia = (): Promise<void> => {
    if (mediaFlushing) return mediaFlushing;
    const run = async () => {
      const context = mediaContext();
      // Failed work returns to its durable queue, but never spins on the same
      // failed claim in one wake. Existing runtime signals provide retries.
      for (let item = 0; item < 10; item++) {
        context.live();
        const attempt = await history.claimNextMediaUpload();
        if (!attempt) return;
        try {
          context.live();
          const parent = await history.getMessage(attempt.messageId);
          if (!parent?.server || parent.unsentAt !== undefined) throw mediaUnavailable();
          const rows = await history.listMedia(parent.conversationId);
          const row = rows.find((value) => value.id === attempt.attachmentId);
          if (!row || row.state !== "UPLOADING" || row.token !== attempt.token || row.attempts !== attempt.attempt
            || row.messageId !== attempt.messageId || row.sha256 !== attempt.sha256) throw mediaUnavailable();
          const bytes = await history.readMedia(row.id);
          context.live();
          if (!bytes) throw mediaUnavailable();
          await context.transport.upload(row, bytes);
          context.live();
          await history.completeMediaUpload(attempt);
        } catch (error) {
          // A stale failure cannot overwrite a reconciled delivery or newer lease.
          await history.failMediaUpload(attempt).catch(() => undefined);
          throw error;
        }
      }
    };
    mediaFlushing = run().finally(() => { mediaFlushing = null; });
    return mediaFlushing;
  };

  async function receiveMedia(metadata: MediaMetadata, context: ReturnType<typeof mediaContext>): Promise<void> {
    context.live();
    const parent = await history.getMessage(metadata.messageId);
    if (!parent?.server || parent.unsentAt !== undefined) throw mediaUnavailable();
    const existing = (await history.listMedia(parent.conversationId)).find((row) => row.messageId === metadata.messageId);
    if (existing && !sameMediaIdentity(existing, metadata)) throw mediaUnavailable();
    const localBytes = existing ? await history.readMedia(metadata.id) : null;
    context.live();
    const bytes = localBytes ?? await context.transport.download(metadata);
    context.live();
    await history.persistVerifiedMediaAndAck(metadata, bytes, (row) => {
      // Begin captured-account work synchronously under the adapter's lock.
      context.live(); return context.transport.ack(row.id);
    });
    context.live();
  }

  const syncMedia = (): Promise<void> => {
    if (mediaSyncing) return mediaSyncing;
    const run = async () => {
      const context = mediaContext(), attempted = new Set<string>();
      let failed = false;
      const receive = async (metadata: MediaMetadata) => {
        attempted.add(metadata.id);
        try { await receiveMedia(metadata, context); return true; }
        catch { context.live(); failed = true; return false; }
      };
      // An ACK may already be recorded remotely while local READY settlement was
      // lost. Such rows no longer appear in discovery: retry from trusted expiry
      // and bytes, never from a locally invented outgoing retention timestamp.
      for (const conversation of await history.listConversations()) {
        context.live();
        for (const row of await history.listMedia(conversation.conversationId)) {
          if (attempted.size >= 100) break;
          if (row.state === "AWAITING_ACK" && row.expiresAt !== null && row.expiresAt > Date.now()) await receive(row);
        }
        if (attempted.size >= 100) break;
      }
      for (let page = 0; page < 10; page++) {
        context.live();
        const deliveries: MediaDelivery[] = await context.transport.fetchDeliveries();
        let progress = 0;
        for (const delivery of deliveries) {
          context.live();
          if (attempted.has(delivery.id)) continue;
          attempted.add(delivery.id);
          const parent = await history.getMessage(delivery.messageId);
          // Text/state sync owns parents. Do not fabricate one from media or
          // download/ACK a suppressed or not-yet-durable message.
          if (!parent?.server || parent.unsentAt !== undefined) continue;
          if (await receive({ ...delivery, direction: parent.authorId === scope.accountId ? "OUT" : "IN" })) progress++;
        }
        // No cursor exists. ACK progress is the only way to drain a full page;
        // remember attempted IDs too, so stuck rows aren't retried within a wake.
        if (deliveries.length < 100 || progress === 0) break;
      }
      if (failed) throw mediaUnavailable();
    };
    mediaSyncing = run().finally(() => { mediaSyncing = null; });
    return mediaSyncing;
  };
  return {
    async start(platform: "web" | "android" | "ios") { await call("REGISTER", { platform }); },
    async request(otherId: string) { return uuid(await call("CREATE", { otherId: uuid(otherId) }) as string); },
    async accept(conversationId: string) { await call("ACCEPT", { conversationId: uuid(conversationId) }); },
    async end(conversationId: string) { await mediaMutation("END", { conversationId: uuid(conversationId) }); },
    async block(conversationId: string) { await mediaMutation("BLOCK", { conversationId: uuid(conversationId) }); },
    async setPrivateState(conversationId: string, operation: "HIDE" | "UNHIDE" | "DECLINE") {
      await call("PRIVATE", { conversationId: uuid(conversationId), operation });
    },
    async removeMessage(conversationId: string, messageId: string, unsend: boolean) {
      const conversation = uuid(conversationId), id = uuid(messageId);
      await withMediaMutation(async () => {
        const pending = !unsend ? await history.getMessage(id) : null;
        assertOpen();
        if (pending && !pending.server) {
          // The adapter rechecks own author/conversation/pending state under the
          // durable transaction; a server echo racing this read cannot slip in.
          await history.removeMediaForMessage(id, conversation);
          assertOpen();
          return;
        }
        uuid(await call(unsend ? "UNSEND" : "DELETE_FOR_ME", { conversationId: conversation, messageId: id }) as string);
        // Do not apply the mutation response out of order and skip intervening
        // state from another own device. Fetch from the durable cursor instead.
        await syncState();
      });
    },
    async clearConversation(conversationId: string, throughSequence: number) {
      uuid(await mediaMutation("CLEAR_FOR_ME", { conversationId: uuid(conversationId), throughSequence: positiveSequence(throughSequence) }) as string);
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
    async sendMedia(value: HumanMessage, input: MediaMetadata, bytes: ArrayBuffer) {
      const context = mediaContext(), message = copyMediaMessage(value), metadata = copyMediaMetadata(input);
      if (message.authorId !== scope.accountId || metadata.direction !== "OUT" || metadata.messageId !== message.id
        || metadata.expiresAt !== null) throw mediaUnavailable();
      await history.enqueueOutgoingWithMedia(message, metadata, bytes);
      context.live();
    },
    async downloadMedia(conversationId: string, attachmentId: string) {
      const context = mediaContext(), id = uuid(attachmentId);
      const row = (await history.listMedia(uuid(conversationId))).find((item) => item.id === id);
      if (!row || row.expiresAt === null) throw mediaUnavailable();
      if (row.expiresAt <= Date.now()) { context.live(); throw new PhotoUnavailableError(); }
      await receiveMedia(row, context);
    },
    sync, syncState, flush, refreshConversations, flushMedia, syncMedia,
    close() { controller.abort(); mediaController.abort(); return Promise.resolve(history.close()); },
  };
}
