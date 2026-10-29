import type {
  HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope,
  OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage, MediaAttachment, MediaBytesPort, HistorySnapshot, ImportReport,
} from "./history";
import { MediaParentUnavailableError } from "./history";
import { cachedMediaAllowed, copyMessage, copyMediaMessage, copyReceivedMessage, compatibleMessageType, copyMediaAttachment, sameMessage, positiveSequence, uuid } from "./validation";
import { isMediaSha256, sameMediaIdentity, verifyMediaBytes, type MediaMetadata, type MediaUploadAttempt } from "./media";
import { verifyMediaContent, type MediaDecoder } from "./mediaContent";
import { withHistoryLock } from "./historyLock";
import {
  conversationPeer, copyConversationProjection, nonnegativeSequence, summarizeConversations,
  type ConversationProjection, type ConversationSummary, type LocalConversationState,
} from "./conversationIndex";
import { copyStateEnvelope, statePeer, type MessageStateChange, type StateChangeEnvelope, type StateCursor } from "./stateChanges";
import { BackupError, normaliseSnapshot, validateSnapshot } from "./backup";
import { erasureMatches, exportPortable, mergePortable, type PortableConversation, type PortableErasure,
  type PortableMessage, type PortableView } from "./indexedDbBackup";

// v6 adds portable suppression metadata to existing records. Fence older
// executables that do not honor it, even though no new object store is needed.
export const MESSAGING_IDB_VERSION = 6;
const STORES = ["messages", "outbox", "events", "mailbox", "conversations", "stateEvents", "deletions", "clears", "unsends", "mediaAttachments", "mediaLifecycle"];
const LEASE_MS = 60_000;

interface EventIdentity {
  eventId: string;
  conversationId: string;
  sequence: number;
  messageId: string;
}

function connect(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, MESSAGING_IDB_VERSION);
    let rejected = false;
    request.onblocked = () => {
      rejected = true;
      reject(new Error("Messaging storage upgrade blocked"));
    };
    request.onerror = () => reject(new Error("Messaging storage could not open"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("conversation", "conversationId");
        db.createObjectStore("outbox", { keyPath: "messageId" });
        db.createObjectStore("mailbox", { keyPath: "mailboxId" });
        const events = db.createObjectStore("events", { keyPath: "eventId" });
        events.createIndex("sequence", ["conversationId", "sequence"], { unique: true });
      }
      // Additive v1 -> v2 upgrade; existing history/outbox identities stay intact.
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "conversationId" });
      }
      if (!db.objectStoreNames.contains("stateEvents")) {
        const events = db.createObjectStore("stateEvents", { keyPath: "eventId" });
        events.createIndex("sequence", "sequence", { unique: true });
        db.createObjectStore("deletions", { keyPath: "messageId" });
        db.createObjectStore("unsends", { keyPath: "messageId" });
        db.createObjectStore("clears", { keyPath: "conversationId" });
      }
      if (!db.objectStoreNames.contains("mediaAttachments")) {
        const media = db.createObjectStore("mediaAttachments", { keyPath: "id" });
        media.createIndex("messageId", "messageId", { unique: true });
      }
      if (!db.objectStoreNames.contains("mediaLifecycle")) db.createObjectStore("mediaLifecycle");
      // Upgrade is one atomic versionchange transaction. Only an existing
      // attachment establishes MEDIA; absent metadata never proves TEXT.
      const tx = request.transaction!;
      const cursor = tx.objectStore("messages").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const message = entry.value as StoredHumanMessage;
        if (message.messageType !== undefined) { entry.continue(); return; }
        const media = tx.objectStore("mediaAttachments").index("messageId").get(message.id);
        media.onsuccess = () => {
          if (media.result) entry.update({ ...message, messageType: "MEDIA" });
          entry.continue();
        };
      };
    };
    request.onsuccess = () => {
      if (rejected) request.result.close();
      else resolve(request.result);
    };
  });
}

/** Explicit web adapter; no Android/SQLite selection or memory fallback. */
export async function openWebMessagingHistory(identity: MessagingScope, options: {
  indexedDB?: IDBFactory; mediaBytes?: MediaBytesPort; decodeMedia?: MediaDecoder;
  /** Production registry guard, called while holding the existing account lock. */
  accountAdmission?: () => Promise<void>;
  /** Trusted platform cleanup handle: purge/close only, no maintenance/admission. */
  cleanupOnly?: boolean;
} = {}): Promise<MessagingHistory> {
  const scope = { accountId: uuid(identity?.accountId), deviceId: uuid(identity?.deviceId) };
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB messaging storage unavailable");
  const db = await connect(factory, `findback-human-history-v1:${scope.accountId}:${scope.deviceId}`);
  let closed = false;
  const active = new Set<IDBTransaction>();
  const lockLifetime = new AbortController();
  const removedBytes = new WeakMap<IDBTransaction, Set<string>>();

  function assertOpen() {
    if (closed) throw new Error("Messaging history closed");
  }

  function updateConversation(
    tx: IDBTransaction, guard: (callback: () => void) => () => void,
    conversationId: string, peerId: string,
    change: (state: LocalConversationState) => LocalConversationState,
  ) {
    if (peerId === scope.accountId) throw new Error("Conversation peer scope mismatch");
    const store = tx.objectStore("conversations");
    const request = store.get(conversationId);
    request.onsuccess = guard(() => {
      const prior = request.result as PortableConversation | undefined;
      if (prior?.peerId) {
        if (prior.peerId !== peerId) throw new Error("Immutable conversation peer conflict");
        store.put(change({ ...prior, peerId: prior.peerId }));
      } else {
        // Older databases have messages but no explicit index yet. Validate the
        // historical binding before caching an online relationship for that id.
        const messages = tx.objectStore("messages").index("conversation").getAll(conversationId);
        messages.onsuccess = guard(() => {
          for (const message of messages.result as StoredHumanMessage[]) {
            if (conversationPeer(scope, message) !== peerId) throw new Error("Immutable conversation peer conflict");
          }
          store.put(change({ ...prior, conversationId, peerId, readThrough: prior?.readThrough ?? 0, updatedAt: prior?.updatedAt ?? 0 }));
        });
      }
    });
  }

  function close(): Promise<void> {
    if (closed) return tail.then(() => undefined);
    closed = true;
    lockLifetime.abort(new Error("Messaging history closed"));
    for (const tx of active) {
      // An externally completed transaction may still await its completion event.
      try { tx.abort(); } catch { /* already finished */ }
    }
    db.close();
    // Invalidate synchronously, but the byte port must outlive any admitted
    // write/rollback cleanup. The platform owner awaits this before closing it.
    return tail.then(() => undefined);
  }
  db.onversionchange = close;
  db.onclose = close;

  function visibleMessages(tx: IDBTransaction, guard: (callback: () => void) => () => void,
    messages: StoredHumanMessage[], done: (messages: StoredHumanMessage[]) => void) {
    const deletions = tx.objectStore("deletions").getAll();
    const clears = tx.objectStore("clears").getAll();
    let remaining = 2;
    const complete = guard(() => {
      if (--remaining !== 0) return;
      const deleted = new Set((deletions.result as Array<{ messageId: string }>).map((row) => row.messageId));
      const cleared = new Map((clears.result as Array<{ conversationId: string; throughSequence: number }>).map((row) => [row.conversationId, row.throughSequence]));
      done(messages.filter((message) => !deleted.has(message.id)
        && (!message.server || message.server.sequence > (cleared.get(message.conversationId) ?? 0))));
    });
    deletions.onsuccess = complete; clears.onsuccess = complete;
  }

  /** Never resolve a durable operation from request success; only tx complete. */
  function transaction<T>(mode: IDBTransactionMode, action: (
    tx: IDBTransaction, result: (value: T) => void, guard: (callback: () => void) => () => void,
  ) => void, onCommitted?: () => void, allowPurged = false): Promise<T> {
    assertOpen();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORES, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      active.add(tx);
      let value: T;
      let failure: unknown;
      const guard = (callback: () => void) => () => {
        try { assertOpen(); callback(); } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        active.delete(tx);
        onCommitted?.();
        const ids = [...(removedBytes.get(tx) ?? [])];
        const cleanup = ids.length && options.mediaBytes
          ? options.mediaBytes.delete(scope.accountId, ids).catch(() => undefined) : Promise.resolve();
        void cleanup.then(() => {
          if (closed) reject(new Error("Messaging history closed"));
          else resolve(value);
        });
      };
      tx.onabort = () => {
        active.delete(tx);
        reject(failure ?? new Error("Messaging storage transaction aborted"));
      };
      // Request errors bubble and abort by default. Do not preventDefault or resolve early.
      guard(() => {
        // Some runtimes accept but ignore the strict option. No storage action may start there.
        if (mode === "readwrite" && tx.durability !== "strict") {
          throw new Error("Messaging storage requires strict transaction durability");
        }
        const start = () => action(tx, (result) => { value = result; }, guard);
        if (allowPurged) start();
        else {
          const fence = tx.objectStore("mediaLifecycle").get("historyPurged");
          fence.onsuccess = guard(() => {
            if (fence.result !== undefined) throw new Error("Messaging history purged");
            start();
          });
        }
      })();
    });
  }

  async function enqueueOutgoing(input: HumanMessage, expectedEpoch?: string): Promise<void> {
    assertOpen();
    const message = copyMessage(input);
    if (message.authorId !== scope.accountId) throw new Error("Outgoing messaging scope mismatch");
    await transaction<void>("readwrite", (tx, result, guard) => {
      const messages = tx.objectStore("messages");
      const request = messages.get(message.id);
      const deleted = tx.objectStore("deletions").get(message.id);
      const unsent = tx.objectStore("unsends").get(message.id);
      const queued = tx.objectStore("outbox").get(message.id);
      const media = tx.objectStore("mediaAttachments").index("messageId").get(message.id);
      let remaining = 5;
      const complete = guard(() => {
        if (--remaining !== 0) return;
        if (deleted.result || unsent.result) throw new Error("Cannot enqueue a removed message");
        const existing = request.result as StoredHumanMessage | undefined;
        if (existing && !sameMessage(existing, message)) throw new Error("Immutable message conflict");
        if (!existing) {
          messages.add(message);
          tx.objectStore("outbox").add({ messageId: message.id, status: "QUEUED", attempts: 0,
            ...(expectedEpoch ? { expectedEpoch } : {}) } satisfies OutboxEntry);
          updateConversation(tx, guard, message.conversationId, conversationPeer(scope, message),
            (state) => ({ ...state, updatedAt: Date.now() }));
        } else if (!existing.messageType && !existing.server && existing.unsentAt === undefined && queued.result) {
          // Explicit text admission, not automatic retry or body inference.
          if (media.result) throw new Error("Media parent classification conflict");
          messages.put({ ...existing, messageType: "TEXT" });
        }
        // Explicit admission may bind a boundary to a row queued before the
        // epoch existed. A boundary the row already carries is never overwritten:
        // that intent belongs to the moment the user composed it.
        if (existing && expectedEpoch) {
          const entry = queued.result as OutboxEntry | undefined;
          if (entry && !entry.expectedEpoch) tx.objectStore("outbox").put({ ...entry, expectedEpoch });
        }
        // Existing queued/failed/sending/sent records are never reset by retry.
        result(undefined);
      });
      request.onsuccess = complete; deleted.onsuccess = complete; unsent.onsuccess = complete;
      queued.onsuccess = complete; media.onsuccess = complete;
    });
  }

  async function getMessage(id: string): Promise<StoredHumanMessage | null> {
    assertOpen(); uuid(id);
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("messages").get(id);
      request.onsuccess = guard(() => visibleMessages(tx, guard,
        request.result ? [request.result as StoredHumanMessage] : [], (messages) => result(messages[0] ?? null)));
    });
  }

  async function listMessages(conversationId: string): Promise<StoredHumanMessage[]> {
    assertOpen(); uuid(conversationId);
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("messages").index("conversation").getAll(conversationId);
      request.onsuccess = guard(() => {
        const messages = request.result as StoredHumanMessage[];
        // Pending messages have no server order. UUID tie-breaker, never timestamp inference.
        messages.sort((a, b) => (a.server?.sequence ?? Infinity) - (b.server?.sequence ?? Infinity) || a.id.localeCompare(b.id));
        visibleMessages(tx, guard, messages, result);
      });
    });
  }

  async function listOutbox(): Promise<OutboxEntry[]> {
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("outbox").getAll();
      const messages = tx.objectStore("messages").getAll();
      let remaining = 2;
      const complete = guard(() => {
        if (--remaining) return;
        const classified = new Set((messages.result as StoredHumanMessage[])
          .filter((message) => message.messageType !== undefined).map((message) => message.id));
        result((request.result as OutboxEntry[]).map((entry) => classified.has(entry.messageId)
          ? entry : { ...entry, status: "NEEDS_REVIEW" }));
      });
      request.onsuccess = complete; messages.onsuccess = complete;
    });
  }

  async function listConversations(): Promise<ConversationSummary[]> {
    return transaction("readonly", (tx, result, guard) => {
      const states = tx.objectStore("conversations").getAll();
      const messages = tx.objectStore("messages").getAll();
      const outbox = tx.objectStore("outbox").getAll();
      let remaining = 3;
      const done = guard(() => {
        if (--remaining === 0) visibleMessages(tx, guard, messages.result as StoredHumanMessage[], (visible) =>
          result(summarizeConversations(scope, (states.result as PortableConversation[])
            .filter((state): state is LocalConversationState => !!state.peerId), visible, outbox.result as OutboxEntry[])));
      });
      states.onsuccess = done; messages.onsuccess = done; outbox.onsuccess = done;
    });
  }

  async function cacheConversation(input: ConversationProjection): Promise<void> {
    const projection = copyConversationProjection(input);
    await transaction<void>("readwrite", (tx, result, guard) => {
      updateConversation(tx, guard, projection.conversationId, projection.peerId, (state) => {
        if (state.projection && state.projection.revision > projection.revision) return state;
        if (state.projection?.revision === projection.revision
          && JSON.stringify(state.projection) !== JSON.stringify(projection)) {
          // A pre-R4 cache has no `epoch`, so it can never equal a server
          // projection. Accept that one upgrade; later same-revision changes
          // remain real conflicts.
          if (state.projection.epoch !== undefined) throw new Error("Conversation revision conflict");
        }
        return { ...state, projection, observedAt: Date.now() };
      });
      result(undefined);
    });
  }

  async function markConversationRead(conversationId: string, throughSequence: number): Promise<void> {
    const id = uuid(conversationId);
    const through = nonnegativeSequence(throughSequence);
    await transaction<void>("readwrite", (tx, result, guard) => {
      const request = tx.objectStore("messages").index("conversation").getAll(id);
      request.onsuccess = guard(() => {
        const messages = request.result as StoredHumanMessage[];
        const highest = messages.reduce((maximum, message) => Math.max(maximum, message.server?.sequence ?? 0), 0);
        if (through > highest) throw new Error("Cannot read beyond local history");
        const first = messages[0];
        if (first) updateConversation(tx, guard, id, conversationPeer(scope, first),
          (state) => ({ ...state, readThrough: Math.max(state.readThrough, through) }));
        result(undefined);
      });
    });
  }

  async function claimNextOutgoing(except: readonly string[] = []): Promise<OutgoingAttempt | null> {
    const skip = new Set(except.filter((id) => typeof id === "string" && id.length > 0));
    return transaction("readwrite", (tx, result, guard) => {
      const outbox = tx.objectStore("outbox");
      const cursor = outbox.openCursor();
      cursor.onsuccess = guard(() => {
        const current = cursor.result;
        if (!current) { result(null); return; }
        const entry = current.value as OutboxEntry;
        if (skip.has(entry.messageId)) { current.continue(); return; }
        const now = Date.now();
        if (entry.status === "SENDING" && (entry.leaseUntil ?? Infinity) > now) {
          current.continue(); return;
        }
        const request = tx.objectStore("messages").get(entry.messageId);
        request.onsuccess = guard(() => {
          const message = request.result as StoredHumanMessage | undefined;
          if (!message || message.server) throw new Error("Messaging outbox identity conflict");
          // NULL/absent classification itself is the durable quarantine. Do not
          // lease or increment attempts; later classified sends must progress.
          if (!message.messageType) { current.continue(); return; }
          const token = crypto.randomUUID();
          const attempts = entry.attempts + 1;
          outbox.put({ messageId: entry.messageId, status: "SENDING", attempts, token, leaseUntil: now + LEASE_MS,
            ...(entry.expectedEpoch ? { expectedEpoch: entry.expectedEpoch } : {}) } satisfies OutboxEntry);
          // A legacy row has no boundary; leaving it absent makes the server
          // refuse the send instead of this client inventing one for it.
          result({ message: copyReceivedMessage(message), token, attempt: attempts,
            ...(entry.expectedEpoch ? { expectedEpoch: entry.expectedEpoch } : {}) });
        });
      });
    });
  }

  async function retryOutgoing(messageId: string, expectedEpoch: string): Promise<boolean> {
    assertOpen();
    const id = uuid(messageId);
    if (typeof expectedEpoch !== "string" || !/^[0-9a-f]{64}$/.test(expectedEpoch)) {
      throw new Error("Invalid messaging boundary");
    }
    return transaction("readwrite", (tx, result, guard) => {
      const outbox = tx.objectStore("outbox");
      const request = outbox.get(id);
      request.onsuccess = guard(() => {
        const entry = request.result as OutboxEntry | undefined;
        if (!entry || entry.status === "SENDING") { result(false); return; }
        outbox.put({ messageId: id, status: "QUEUED", attempts: 0, expectedEpoch } satisfies OutboxEntry);
        result(true);
      });
    });
  }

  async function failOutgoing(input: OutgoingAttempt): Promise<boolean> {
    assertOpen();
    const message = copyReceivedMessage(input.message);
    const token = uuid(input.token);
    const attempt = input.attempt;
    if (message.authorId !== scope.accountId || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("Invalid outgoing attempt scope");
    }
    return transaction("readwrite", (tx, result, guard) => {
      const outbox = tx.objectStore("outbox");
      const request = outbox.get(message.id);
      request.onsuccess = guard(() => {
        const entry = request.result as OutboxEntry | undefined;
        if (!entry || entry.status !== "SENDING" || entry.token !== token || entry.attempts !== attempt) {
          result(false); return;
        }
        const stored = tx.objectStore("messages").get(message.id);
        stored.onsuccess = guard(() => {
          if (!stored.result || !sameMessage(stored.result as StoredHumanMessage, message)) throw new Error("Outgoing attempt identity conflict");
          outbox.put({ messageId: message.id, status: "FAILED", attempts: attempt,
            ...(entry.expectedEpoch ? { expectedEpoch: entry.expectedEpoch } : {}) } satisfies OutboxEntry);
          result(true);
        });
      });
    });
  }

  async function persistInbound(input: MailboxEnvelope): Promise<PersistenceReceipt> {
    assertOpen();
    if (!input || input.accountId !== scope.accountId || input.deviceId !== scope.deviceId) {
      throw new Error("Inbound messaging scope mismatch");
    }
    const mailboxId = uuid(input.mailboxId);
    if (input.event?.kind !== "TEXT") throw new Error("Unsupported messaging event");
    const eventId = uuid(input.event.eventId);
    const sequence = input.event.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid messaging event sequence");
    const message = copyReceivedMessage(input.event.message);
    if (message.authorId !== scope.accountId && message.recipientId !== scope.accountId) {
      throw new Error("Inbound participant scope mismatch");
    }
    const receipt = { ...scope, mailboxId, eventId };
    return transaction("readwrite", (tx, result, guard) => {
      const mailbox = tx.objectStore("mailbox");
      const mailboxRequest = mailbox.get(mailboxId);
      const events = tx.objectStore("events");
      mailboxRequest.onsuccess = guard(() => {
        const existingMailbox = mailboxRequest.result as PersistenceReceipt | undefined;
        if (existingMailbox && existingMailbox.eventId !== eventId) {
          throw new Error("Immutable mailbox identity conflict");
        }
        const eventRequest = events.get(eventId);
        eventRequest.onsuccess = guard(() => {
          const existingEvent = eventRequest.result as EventIdentity | undefined;
          if (existingEvent && (existingEvent.messageId !== message.id || existingEvent.conversationId !== message.conversationId || existingEvent.sequence !== sequence)) {
            throw new Error("Immutable event identity conflict");
          }
          const messages = tx.objectStore("messages");
          const request = messages.get(message.id);
          const removed = tx.objectStore("unsends").get(message.id);
          const deleted = tx.objectStore("deletions").get(message.id);
          const clear = tx.objectStore("clears").get(message.conversationId);
          let remaining = 4;
          const complete = guard(() => {
            if (--remaining !== 0) return;
            const existing = request.result as PortableMessage | undefined;
            // Anti-resurrection: the mailbox receipt and the message row are
            // written in one strict transaction, so a recorded envelope with no
            // stored row means the local history was deliberately deleted. A
            // replay may acknowledge identity, never restore content or the
            // conversation entry.
            if (existingMailbox && !existing) { result(receipt); return; }
            const tombstone = removed.result as PortableErasure | undefined;
            const deletion = deleted.result as PortableErasure | undefined;
            for (const state of [tombstone, deletion]) {
              if (state && !erasureMatches(state, message, sequence)) throw new Error("Erasure message identity conflict");
            }
            if (tombstone?.recipientId == null && tombstone) {
              tx.objectStore("unsends").put({ ...tombstone, recipientId: message.recipientId });
            }
            const suppressed = existing?.snapshotSuppressed || existing?.unsentAt !== undefined || !!deletion
              || sequence <= ((clear.result as { throughSequence: number } | undefined)?.throughSequence ?? 0);
            if (existing && (existing.id !== message.id || existing.conversationId !== message.conversationId
              || existing.authorId !== message.authorId || existing.recipientId !== message.recipientId
              || !compatibleMessageType(existing.messageType, message.messageType)
              || (!tombstone && !suppressed && !sameMessage(existing, message)))) throw new Error("Immutable message conflict");
            if (existing?.server && (existing.server.eventId !== eventId || existing.server.sequence !== sequence)) {
              throw new Error("Immutable message event conflict");
            }
            if (!existingEvent) events.add({ eventId, conversationId: message.conversationId, sequence, messageId: message.id } satisfies EventIdentity);
            const stored: PortableMessage = { ...existing, ...message, server: { eventId, sequence },
              ...((message.messageType ?? existing?.messageType) ? { messageType: message.messageType ?? existing?.messageType } : {}),
              ...((tombstone || suppressed) ? { body: "" } : {}),
              ...(tombstone ? { unsentAt: tombstone.occurredAt } : {}) };
            if (tombstone || suppressed) removeMediaRows(tx, guard, message.id);
            if (!existing) messages.add(stored);
            else if (!existing.server || tombstone || suppressed || (!existing.messageType && message.messageType)) messages.put(stored);
            if (!existing?.server) updateConversation(tx, guard, message.conversationId,
              conversationPeer(scope, message), (state) => ({ ...state, updatedAt: Date.now() }));
            if (!existingMailbox) mailbox.add(receipt);
            // Only this participant-authorized durable echo can confirm server success.
            if (message.authorId === scope.accountId) tx.objectStore("outbox").delete(message.id);
            result(receipt);
          });
          request.onsuccess = complete; removed.onsuccess = complete; deleted.onsuccess = complete; clear.onsuccess = complete;
        });
      });
    });
  }

  async function getStateCursor(): Promise<StateCursor | null> {
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("stateEvents").index("sequence").openCursor(null, "prev");
      request.onsuccess = guard(() => {
        const change = request.result?.value as MessageStateChange | undefined;
        result(change ? { eventId: change.eventId, sequence: change.sequence } : null);
      });
    });
  }

  async function applyStateChange(input: StateChangeEnvelope): Promise<StateCursor> {
    const { change } = copyStateEnvelope(input, scope);
    return transaction("readwrite", (tx, result, guard) => {
      const events = tx.objectStore("stateEvents");
      const prior = events.get(change.eventId);
      prior.onsuccess = guard(() => {
        if (prior.result) {
          if (JSON.stringify(prior.result) !== JSON.stringify(change)) throw new Error("Immutable messaging state conflict");
          result({ eventId: change.eventId, sequence: change.sequence }); return;
        }
        updateConversation(tx, guard, change.conversationId, statePeer(scope, change), (state) => state);
        const messages = tx.objectStore("messages");
        if (change.kind === "CLEAR_FOR_ME") {
          const current = tx.objectStore("clears").get(change.conversationId);
          current.onsuccess = guard(() => {
            const existing = current.result as { throughSequence: number } | undefined;
            if (!existing || existing.throughSequence < change.throughSequence) tx.objectStore("clears").put(change);
          });
          const cursor = messages.index("conversation").openCursor(change.conversationId);
          cursor.onsuccess = guard(() => {
            const entry = cursor.result;
            if (!entry) return;
            const message = entry.value as StoredHumanMessage;
            if (message.server && message.server.sequence <= change.throughSequence) {
              entry.update({ ...message, body: "" });
              removeMediaRows(tx, guard, message.id);
            }
            entry.continue();
          });
        } else {
          const request = messages.get(change.messageId);
          const deletion = tx.objectStore("deletions").get(change.messageId);
          const unsend = tx.objectStore("unsends").get(change.messageId);
          const identities = tx.objectStore("events");
          const byId = identities.get(change.messageId);
          const bySequence = identities.index("sequence").get([change.conversationId, change.messageSequence]);
          let remaining = 5;
          const complete = guard(() => {
            if (--remaining !== 0) return;
            // A stored identity at this (conversation, sequence) may be the TEXT
            // echo, whose eventId is the server's event id rather than the
            // message id. It is authoritative only if it describes the same
            // message; never require the ids to be equal.
            for (const source of [byId.result, bySequence.result]) {
              const identity = source as EventIdentity | undefined;
              if (identity && (identity.messageId !== change.messageId
                || identity.conversationId !== change.conversationId || identity.sequence !== change.messageSequence)) {
                throw new Error("Messaging state event identity conflict");
              }
            }
            // A state change is metadata, not the message's TEXT event, so it
            // never creates an event identity: the authoritative echo owns that
            // slot and a synthetic entry here would collide with it.
            for (const source of [deletion.result, unsend.result]) {
              const prior = source as PortableErasure | undefined;
              if (prior && !erasureMatches(prior, { id: change.messageId, ...change }, change.messageSequence)) {
                throw new Error("Erasure message identity conflict");
              }
              if (prior?.kind === "UNSEND" && change.kind === "UNSEND" && prior.occurredAt !== change.occurredAt) {
                throw new Error("Erasure message identity conflict");
              }
            }
            const existing = request.result as PortableMessage | undefined;
            if (existing && (existing.conversationId !== change.conversationId || existing.authorId !== change.authorId
              || existing.recipientId !== change.recipientId
              || (existing.server && existing.server.sequence !== change.messageSequence)
              || (change.kind === "UNSEND" && existing.unsentAt !== undefined && existing.unsentAt !== change.occurredAt))) {
              throw new Error("Messaging state message identity conflict");
            }
            if (change.kind === "DELETE_FOR_ME") tx.objectStore("deletions").put(change);
            else tx.objectStore("unsends").put(change);
            messages.put({ ...existing, id: change.messageId, conversationId: change.conversationId,
                authorId: change.authorId, recipientId: change.recipientId, body: "",
                ...(existing?.messageType ? { messageType: existing.messageType } : {}),
                ...(existing?.server ? { server: existing.server } : {}),
                ...(existing?.unsentAt !== undefined ? { unsentAt: existing.unsentAt }
                  : change.kind === "UNSEND" ? { unsentAt: change.occurredAt } : {}) } satisfies StoredHumanMessage);
            tx.objectStore("outbox").delete(change.messageId);
            removeMediaRows(tx, guard, change.messageId);
          });
          request.onsuccess = complete; deletion.onsuccess = complete; unsend.onsuccess = complete;
          byId.onsuccess = complete; bySequence.onsuccess = complete;
        }
        events.add(change);
        result({ eventId: change.eventId, sequence: change.sequence });
      });
    });
  }

  async function persistInboundAndAck(envelope: MailboxEnvelope, ack: (receipt: PersistenceReceipt) => Promise<void>): Promise<void> {
    const receipt = await serializedPersist(envelope);
    const { completion } = await serial(async () => {
      assertOpen();
      const completion = Promise.resolve(ack(receipt));
      void completion.catch(() => undefined);
      return { completion };
    })();
    await completion;
  }

  function snapshotTransaction<T>(mode: IDBTransactionMode,
    work: (view: PortableView, tx: IDBTransaction, guard: (callback: () => void) => () => void) => T): Promise<T> {
    return transaction(mode, (tx, result, guard) => {
      const names = ["messages", "conversations", "unsends", "deletions", "clears"] as const;
      const requests = names.map((name) => tx.objectStore(name).getAll());
      let remaining = requests.length;
      const complete = guard(() => {
        if (--remaining) return;
        const view = Object.fromEntries(names.map((name, index) => [name, requests[index]!.result])) as unknown as PortableView;
        result(work(view, tx, guard));
      });
      for (const request of requests) request.onsuccess = complete;
    });
  }
  function exportSnapshot(): Promise<HistorySnapshot> {
    return snapshotTransaction("readonly", exportPortable);
  }
  function importSnapshot(incoming: HistorySnapshot): Promise<ImportReport> {
    // Captured/validated by the public wrapper before structuredClone can invoke getters.
    return snapshotTransaction("readwrite", (view, tx, guard) => {
      const merged = mergePortable(view, incoming, scope);
      for (const state of merged.conversations) tx.objectStore("conversations").put(state);
      for (const state of merged.unsends) tx.objectStore("unsends").put(state);
      for (const state of merged.deletions) tx.objectStore("deletions").put(state);
      for (const state of merged.clears) tx.objectStore("clears").put(state);
      for (const message of merged.messages) {
        tx.objectStore("messages").put(message);
        if (message.snapshotSuppressed) removeMediaRows(tx, guard, message.id);
        if (message.server || message.snapshotSuppressed) tx.objectStore("outbox").delete(message.id);
      }
      // Imported accepted identities reserve the same immutable slots as echoes,
      // but never create mailbox receipts or state events/cursors.
      for (const message of incoming.messages) {
        const events = tx.objectStore("events"), request = events.get(message.serverEventId);
        const atSequence = events.index("sequence").get([message.conversationId, message.serverSequence]);
        let remaining = 2;
        const complete = guard(() => {
          if (--remaining) return;
          for (const row of [request.result, atSequence.result] as Array<EventIdentity | undefined>) {
            if (row && (row.messageId !== message.id || row.conversationId !== message.conversationId
              || row.eventId !== message.serverEventId || row.sequence !== message.serverSequence)) {
              throw new BackupError("backup: identity conflict");
            }
          }
          events.put({ eventId: message.serverEventId, conversationId: message.conversationId,
            sequence: message.serverSequence, messageId: message.id } satisfies EventIdentity);
        });
        request.onsuccess = complete; atSequence.onsuccess = complete;
      }
      return { conversations: incoming.conversations.length, messages: incoming.messages.length,
        tombstones: incoming.tombstones.length, deletedForMe: incoming.deletedForMe.length, clears: incoming.clears.length };
    });
  }

  function removeMediaRows(tx: IDBTransaction, guard: (callback: () => void) => () => void, messageId: string) {
    const store = tx.objectStore("mediaAttachments");
    const request = store.index("messageId").get(messageId);
    request.onsuccess = guard(() => {
      const row = request.result as MediaAttachment | undefined;
      if (!row) return;
      store.delete(row.id);
      const ids = removedBytes.get(tx) ?? new Set<string>();
      ids.add(row.id);
      removedBytes.set(tx, ids);
    });
  }

  interface MediaView {
    records: MediaAttachment[]; parents: StoredHumanMessage[]; purged: boolean;
    states: LocalConversationState[];
  }
  function mediaTransaction<T>(mode: IDBTransactionMode,
    work: (view: MediaView, tx: IDBTransaction, guard: (callback: () => void) => () => void) => T,
    onCommitted?: () => void): Promise<T> {
    return transaction(mode, (tx, result, guard) => {
      const records = tx.objectStore("mediaAttachments").getAll();
      const messages = tx.objectStore("messages").getAll();
      const purged = tx.objectStore("mediaLifecycle").get("purged");
      const states = tx.objectStore("conversations").getAll();
      let remaining = 4;
      const complete = guard(() => {
        if (--remaining) return;
        visibleMessages(tx, guard, messages.result as StoredHumanMessage[], (parents) => {
          result(work({ records: records.result.map(copyMediaAttachment), purged: purged.result === true,
            states: states.result as LocalConversationState[],
            parents: parents.filter((parent) => parent.unsentAt === undefined && !(parent as PortableMessage).snapshotSuppressed) }, tx, guard));
        });
      });
      records.onsuccess = complete; messages.onsuccess = complete; purged.onsuccess = complete;
      states.onsuccess = complete;
    }, onCommitted);
  }

  let mediaPurged = false;
  function byteStore(): MediaBytesPort {
    if (!options.mediaBytes) throw new Error("Messaging media byte storage unavailable");
    return options.mediaBytes;
  }

  function mediaParent(view: MediaView, metadata: MediaMetadata): StoredHumanMessage {
    const parent = view.parents.find((row) => row.id === metadata.messageId);
    if (!parent) throw new MediaParentUnavailableError(metadata.messageId);
    if (parent.authorId !== scope.accountId && parent.recipientId !== scope.accountId) throw new Error("Media participant scope mismatch");
    if (parent.messageType === "TEXT") throw new Error("Media parent classification conflict");
    if (metadata.direction !== (parent.authorId === scope.accountId ? "OUT" : "IN")) throw new Error("Media direction scope mismatch");
    return parent;
  }

  function mediaReplay(view: MediaView, metadata: MediaMetadata): MediaAttachment | undefined {
    const existing = view.records.find((row) => row.id === metadata.id);
    const byMessage = view.records.find((row) => row.messageId === metadata.messageId);
    if ((existing && !sameMediaIdentity(existing, metadata)) || (byMessage && byMessage.id !== metadata.id)) {
      throw new Error("Media identity conflict");
    }
    return existing;
  }

  function canSendMedia(view: MediaView, conversationId: string): boolean {
    return cachedMediaAllowed(view.states.find((state) => state.conversationId === conversationId)?.projection);
  }

  async function storeMedia(record: MediaAttachment, bytes: ArrayBuffer, message?: HumanMessage,
    expectedEpoch?: string): Promise<MediaAttachment> {
    const store = byteStore();
    await mediaTransaction("readonly", (view) => {
      if (view.purged) throw new Error("Messaging media purged");
      if (message && !canSendMedia(view, message.conversationId)) throw new Error("Media unavailable");
      mediaReplay(view, record);
      if (!message) mediaParent(view, record);
    });
    await verifyMediaContent(record, bytes, options.decodeMedia);
    const prior = await store.get(scope.accountId, record.id);
    if (prior) await verifyMediaBytes(record, prior);
    else await store.put(scope.accountId, record.id, bytes);
    let committed = false;
    try {
      return await mediaTransaction("readwrite", (view, tx, guard) => {
        if (view.purged) throw new Error("Messaging media purged");
        if (message && !canSendMedia(view, message.conversationId)) throw new Error("Media unavailable");
        const existing = mediaReplay(view, record);
        const write = () => {
          const saved = existing ? copyMediaAttachment({ ...existing,
            ...(message ? {} : { state: "AWAITING_ACK", token: undefined, leaseUntil: undefined,
              expiresAt: record.expiresAt ?? existing.expiresAt, lastAccessAt: record.lastAccessAt }),
          }) : record;
          tx.objectStore("mediaAttachments").put(saved);
          return saved;
        };
        if (!message) { mediaParent(view, record); return write(); }
        // The erasure requests stay inside this strict metadata transaction.
        const deleted = tx.objectStore("deletions").get(message.id);
        const unsent = tx.objectStore("unsends").get(message.id);
        const request = tx.objectStore("messages").get(message.id);
        let remaining = 3;
        const complete = guard(() => {
          if (--remaining) return;
          if (deleted.result || unsent.result) throw new MediaParentUnavailableError(message.id);
          const parent = request.result as StoredHumanMessage | undefined;
          if (parent) {
            // Identity first: a TEXT parent and a MEDIA admission are two known,
            // contradictory classifications, and that is the answer the caller
            // needs. Classification alone would also hide a body/scope conflict.
            if (!sameMessage(parent, message)) throw new Error("Immutable message identity conflict");
            mediaParent(view, record);
            if (!parent.messageType) tx.objectStore("messages").put({ ...parent, messageType: "MEDIA" });
          } else {
            tx.objectStore("messages").add(message);
            tx.objectStore("outbox").add({ messageId: message.id, status: "QUEUED", attempts: 0,
              ...(expectedEpoch ? { expectedEpoch } : {}) } satisfies OutboxEntry);
            updateConversation(tx, guard, message.conversationId, conversationPeer(scope, message),
              (state) => ({ ...state, updatedAt: Date.now() }));
          }
          write();
        });
        deleted.onsuccess = complete; unsent.onsuccess = complete; request.onsuccess = complete;
        return existing ?? record;
      }, () => { committed = true; });
    } catch (error) {
      if (!committed && !prior) await store.delete(scope.accountId, [record.id]).catch(() => undefined);
      throw error;
    }
  }

  async function enqueueOutgoingWithMedia(input: HumanMessage, metadata: MediaMetadata, bytes: ArrayBuffer,
    expectedEpoch?: string): Promise<void> {
    assertOpen();
    const message = copyMediaMessage(input);
    const record = copyMediaAttachment({ ...metadata, state: "QUEUED", attempts: 0, lastAccessAt: Date.now() });
    if (message.authorId !== scope.accountId || record.direction !== "OUT" || record.messageId !== message.id) {
      throw new Error("Outgoing media scope mismatch");
    }
    await storeMedia(record, bytes, message, expectedEpoch);
  }

  async function claimNextMediaUpload(): Promise<MediaUploadAttempt | null> {
    const store = byteStore();
    const now = Date.now();
    const candidate = await mediaTransaction("readonly", (view) => view.records
      .filter((row) => row.direction === "OUT" && (row.state === "QUEUED" || row.state === "FAILED"
        || (row.state === "UPLOADING" && row.leaseUntil! <= now))
        && view.parents.some((parent) => parent.id === row.messageId && parent.server
          && canSendMedia(view, parent.conversationId)))
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id))[0]);
    if (!candidate) return null;
    const bytes = await store.get(scope.accountId, candidate.id);
    if (!bytes) throw new Error("Media bytes missing");
    await verifyMediaBytes(candidate, bytes);
    return mediaTransaction("readwrite", (view, tx) => {
      const current = mediaReplay(view, candidate);
      if (!current || JSON.stringify(current) !== JSON.stringify(candidate)) return null;
      if (!mediaParent(view, current).server) return null;
      const token = uuid(crypto.randomUUID());
      const claimed = copyMediaAttachment({ ...current, state: "UPLOADING", token,
        leaseUntil: now + LEASE_MS, attempts: current.attempts + 1 });
      tx.objectStore("mediaAttachments").put(claimed);
      return { attachmentId: current.id, messageId: current.messageId, sha256: current.sha256,
        token, attempt: claimed.attempts };
    });
  }

  async function settleMediaUpload(input: MediaUploadAttempt, success: boolean): Promise<boolean> {
    byteStore();
    const id = uuid(input?.attachmentId), messageId = uuid(input?.messageId), token = uuid(input?.token);
    const attempt = positiveSequence(input?.attempt);
    if (!isMediaSha256(input?.sha256)) throw new Error("Invalid media digest");
    return mediaTransaction("readwrite", (view, tx) => {
      const row = view.records.find((item) => item.id === id);
      if (!row) return false;
      if (row.messageId !== messageId || row.sha256 !== input.sha256) throw new Error("Media attempt identity conflict");
      if (row.state !== "UPLOADING" || row.token !== token || row.attempts !== attempt) return false;
      mediaParent(view, row);
      tx.objectStore("mediaAttachments").put(copyMediaAttachment({ ...row,
        state: success ? "AWAITING_ACK" : "FAILED", token: undefined, leaseUntil: undefined }));
      return true;
    });
  }

  async function markMediaReady(id: string): Promise<boolean> {
    const store = byteStore(); uuid(id);
    const bytes = await store.get(scope.accountId, id);
    const row = await mediaTransaction("readonly", (view) => view.records.find((record) => record.id === id));
    if (!row || row.state !== "AWAITING_ACK") return false;
    if (!bytes) throw new Error("Media bytes missing");
    await verifyMediaBytes(row, bytes);
    return mediaTransaction("readwrite", (view, tx) => {
      const current = mediaReplay(view, row);
      if (!current || current.state !== "AWAITING_ACK") return false;
      mediaParent(view, current);
      tx.objectStore("mediaAttachments").put(copyMediaAttachment({ ...current, state: "READY" }));
      return true;
    });
  }

  async function listMedia(conversationId: string): Promise<MediaAttachment[]> {
    uuid(conversationId);
    return mediaTransaction("readonly", (view) => view.parents
      .filter((parent) => parent.conversationId === conversationId)
      .sort((a, b) => (a.server?.sequence ?? Infinity) - (b.server?.sequence ?? Infinity) || a.id.localeCompare(b.id))
      .flatMap((parent) => view.records.filter((row) => row.messageId === parent.id)));
  }

  async function readMedia(attachmentId: string): Promise<ArrayBuffer | null> {
    uuid(attachmentId);
    const store = byteStore();
    const row = await mediaTransaction("readonly", (view) => {
      const record = view.records.find((item) => item.id === attachmentId);
      if (!record || record.state === "EVICTED" || !view.parents.some((parent) => parent.id === record.messageId)) return null;
      mediaParent(view, record);
      return record;
    });
    if (!row) return null;
    const bytes = await store.get(scope.accountId, attachmentId);
    if (!bytes) return null;
    await verifyMediaBytes(row, bytes);
    return mediaTransaction("readwrite", (view, tx) => {
      const current = mediaReplay(view, row);
      if (!current || current.state === "EVICTED" || !view.parents.some((parent) => parent.id === row.messageId)) return null;
      tx.objectStore("mediaAttachments").put(copyMediaAttachment({ ...current, lastAccessAt: Date.now() }));
      return bytes;
    });
  }

  function sweepLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid media sweep limit");
    return limit;
  }

  async function evictMedia(limit: number): Promise<number> {
    const store = byteStore(); sweepLimit(limit);
    const ids = await mediaTransaction("readwrite", (view, tx) => {
      const rows = view.records.filter((row) => row.state === "READY")
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.id.localeCompare(b.id)).slice(0, limit);
      for (const row of rows) tx.objectStore("mediaAttachments").put(copyMediaAttachment({ ...row, state: "EVICTED" }));
      return rows.map((row) => row.id);
    });
    await store.delete(scope.accountId, ids);
    return ids.length;
  }

  async function sweepOrphanMedia(limit: number): Promise<number> {
    const store = byteStore(); sweepLimit(limit);
    const keep = await mediaTransaction("readonly", (view) => new Set(view.records
      .filter((row) => row.state !== "EVICTED").map((row) => row.id)));
    return store.sweep(scope.accountId, keep, limit);
  }

  async function removeMediaForMessage(messageId: string, pendingConversationId?: string): Promise<void> {
    byteStore(); uuid(messageId);
    if (pendingConversationId !== undefined) uuid(pendingConversationId);
    await mediaTransaction("readwrite", (view, tx, guard) => {
      const parent = view.parents.find((row) => row.id === messageId);
      if (!parent) return;
      if (pendingConversationId !== undefined && (parent.authorId !== scope.accountId
        || parent.conversationId !== pendingConversationId || parent.server)) {
        throw new Error("Message is no longer pending in this conversation");
      }
      tx.objectStore("deletions").put({ kind: "DELETE_FOR_ME", messageId, local: true,
        conversationId: parent.conversationId, authorId: parent.authorId,
        recipientId: parent.recipientId, occurredAt: Date.now() });
      tx.objectStore("messages").put({ ...parent, body: "" });
      tx.objectStore("outbox").delete(messageId);
      removeMediaRows(tx, guard, messageId);
    });
  }

  async function clearMedia(): Promise<void> {
    const store = byteStore();
    await transaction("readwrite", (tx, result) => {
      tx.objectStore("mediaLifecycle").put(true, "purged");
      tx.objectStore("mediaAttachments").clear(); result(undefined);
    });
    mediaPurged = true;
    await store.clearAccount(scope.accountId);
  }

  function historyIsPurged(): Promise<boolean> {
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("mediaLifecycle").get("historyPurged");
      request.onsuccess = guard(() => result(request.result !== undefined));
    }, undefined, true);
  }

  async function purgeHistory(): Promise<void> {
    const store = byteStore();
    await transaction("readwrite", (tx, result, guard) => {
      for (const name of STORES) tx.objectStore(name).clear();
      const lifecycle = tx.objectStore("mediaLifecycle");
      lifecycle.put(true, "historyPurged"); lifecycle.put(true, "purged");
      for (const name of STORES) {
        const count = tx.objectStore(name).count();
        count.onsuccess = guard(() => {
          if (count.result !== (name === "mediaLifecycle" ? 2 : 0)) throw new Error("Messaging history purge incomplete");
        });
      }
      result(undefined);
    }, undefined, true);
    mediaPurged = true;
    await store.clearAccount(scope.accountId);
    if ((await store.keys(scope.accountId)).length) {
      throw new Error("Messaging history bytes remain");
    }
  }

  let tail: Promise<unknown> = Promise.resolve();
  function serial<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>, allowPurged = false) {
    return async (...args: Args): Promise<Result> => {
      const captured = structuredClone(args);
      const next = tail.then(() => {
        assertOpen();
        return withHistoryLock(scope.accountId, lockLifetime.signal, allowPurged || !!options.mediaBytes || !!options.accountAdmission,
          async () => {
            assertOpen();
            if (!allowPurged && options.cleanupOnly) throw new Error("Messaging deletion cleanup only");
            if (!allowPurged) await options.accountAdmission?.();
            if (!allowPurged && await historyIsPurged()) throw new Error("Messaging history purged");
            assertOpen(); return work(...captured);
          });
      });
      tail = next.catch(() => undefined);
      return next;
    };
  }
  const serializedPersist = serial(persistInbound);
  const serializedMediaPersist = serial(async (metadata: MediaMetadata, bytes: ArrayBuffer) => {
    const record = copyMediaAttachment({ ...metadata, state: "AWAITING_ACK", attempts: 0, lastAccessAt: Date.now() });
    return storeMedia(record, bytes);
  });
  const serializedMediaReady = serial(markMediaReady);
  async function persistVerifiedMediaAndAck(metadata: MediaMetadata, bytes: ArrayBuffer,
    ack: (attachment: MediaAttachment) => Promise<void>): Promise<void> {
    if (typeof ack !== "function") throw new Error("Invalid media ACK callback");
    const record = await serializedMediaPersist(metadata, bytes);
    const { completion } = await serial(async () => {
      const current = await mediaTransaction("readonly", (view) => {
        if (view.purged) throw new Error("Messaging media purged");
        const row = mediaReplay(view, record);
        if (!row || (row.state !== "AWAITING_ACK" && row.state !== "READY")) throw new Error("Media unavailable");
        mediaParent(view, row);
        return row;
      });
      const stored = await byteStore().get(scope.accountId, current.id);
      if (!stored) throw new Error("Media bytes missing");
      await verifyMediaBytes(current, stored);
      // Dispatch synchronously under the account lock, but release it without
      // awaiting network completion. The callback may reenter this history.
      assertOpen();
      const completion = Promise.resolve(ack(structuredClone(current)));
      void completion.catch(() => undefined);
      return { completion };
    })();
    await completion;
    if (!closed && !mediaPurged) await serializedMediaReady(record.id);
  }

  if (options.mediaBytes && !options.cleanupOnly) {
    try { await serial(async () => { if (!await historyIsPurged()) await sweepOrphanMedia(100); }, true)(); }
    catch (error) { await close(); throw error; }
  }

  return { enqueueOutgoing: serial(enqueueOutgoing), getMessage: serial(getMessage), listMessages: serial(listMessages),
    listConversations: serial(listConversations), cacheConversation: serial(cacheConversation),
    markConversationRead: serial(markConversationRead), getStateCursor: serial(getStateCursor),
    applyStateChange: serial(applyStateChange), listOutbox: serial(listOutbox), claimNextOutgoing: serial(claimNextOutgoing),
    retryOutgoing: serial(retryOutgoing), failOutgoing: serial(failOutgoing), persistInbound: serializedPersist, persistInboundAndAck, close,
    enqueueOutgoingWithMedia: serial(enqueueOutgoingWithMedia), claimNextMediaUpload: serial(claimNextMediaUpload),
    failMediaUpload: serial((attempt: MediaUploadAttempt) => settleMediaUpload(attempt, false)),
    completeMediaUpload: serial((attempt: MediaUploadAttempt) => settleMediaUpload(attempt, true)),
    persistVerifiedMediaAndAck, markMediaReady: serializedMediaReady, listMedia: serial(listMedia), readMedia: serial(readMedia),
    evictMedia: serial(evictMedia), sweepOrphanMedia: serial(sweepOrphanMedia),
    removeMediaForMessage: serial(removeMediaForMessage), clearMedia: serial(clearMedia), purgeHistory: serial(purgeHistory, true),
    exportSnapshot: serial(exportSnapshot), importSnapshot: async (input) => {
      const captured = normaliseSnapshot(input);
      validateSnapshot(captured, scope.accountId);
      return serial(importSnapshot)(captured);
    } };
}
