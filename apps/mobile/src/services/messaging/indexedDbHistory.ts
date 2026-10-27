import type {
  HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope,
  OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage,
} from "./history";
import { copyMessage, sameMessage, uuid } from "./validation";
import {
  conversationPeer, copyConversationProjection, nonnegativeSequence, summarizeConversations,
  type ConversationProjection, type ConversationSummary, type LocalConversationState,
} from "./conversationIndex";
import { copyStateEnvelope, statePeer, type MessageStateChange, type StateChangeEnvelope, type StateCursor } from "./stateChanges";

const STORES = ["messages", "outbox", "events", "mailbox", "conversations", "stateEvents", "deletions", "clears", "unsends"];
const LEASE_MS = 60_000;

interface EventIdentity {
  eventId: string;
  conversationId: string;
  sequence: number;
  messageId: string;
}

function connect(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 3);
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
    };
    request.onsuccess = () => {
      if (rejected) request.result.close();
      else resolve(request.result);
    };
  });
}

/** Explicit web adapter; no Android/SQLite selection or memory fallback. */
export async function openWebMessagingHistory(identity: MessagingScope, options: { indexedDB?: IDBFactory } = {}): Promise<MessagingHistory> {
  const scope = { accountId: uuid(identity?.accountId), deviceId: uuid(identity?.deviceId) };
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB messaging storage unavailable");
  const db = await connect(factory, `findback-human-history-v1:${scope.accountId}:${scope.deviceId}`);
  let closed = false;
  const active = new Set<IDBTransaction>();

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
      const prior = request.result as LocalConversationState | undefined;
      if (prior) {
        if (prior.peerId !== peerId) throw new Error("Immutable conversation peer conflict");
        store.put(change(prior));
      } else {
        // Older databases have messages but no explicit index yet. Validate the
        // historical binding before caching an online relationship for that id.
        const messages = tx.objectStore("messages").index("conversation").getAll(conversationId);
        messages.onsuccess = guard(() => {
          for (const message of messages.result as StoredHumanMessage[]) {
            if (conversationPeer(scope, message) !== peerId) throw new Error("Immutable conversation peer conflict");
          }
          store.put(change({ conversationId, peerId, readThrough: 0, updatedAt: 0 }));
        });
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const tx of active) {
      // An externally completed transaction may still await its completion event.
      try { tx.abort(); } catch { /* already finished */ }
    }
    db.close();
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
  ) => void): Promise<T> {
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
        if (closed) reject(new Error("Messaging history closed"));
        else resolve(value);
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
        action(tx, (result) => { value = result; }, guard);
      })();
    });
  }

  async function enqueueOutgoing(input: HumanMessage): Promise<void> {
    assertOpen();
    const message = copyMessage(input);
    if (message.authorId !== scope.accountId) throw new Error("Outgoing messaging scope mismatch");
    await transaction<void>("readwrite", (tx, result, guard) => {
      const messages = tx.objectStore("messages");
      const request = messages.get(message.id);
      const deleted = tx.objectStore("deletions").get(message.id);
      const unsent = tx.objectStore("unsends").get(message.id);
      let remaining = 3;
      const complete = guard(() => {
        if (--remaining !== 0) return;
        if (deleted.result || unsent.result) throw new Error("Cannot enqueue a removed message");
        const existing = request.result as StoredHumanMessage | undefined;
        if (existing && !sameMessage(existing, message)) throw new Error("Immutable message conflict");
        if (!existing) {
          messages.add(message);
          tx.objectStore("outbox").add({ messageId: message.id, status: "QUEUED", attempts: 0 } satisfies OutboxEntry);
          updateConversation(tx, guard, message.conversationId, conversationPeer(scope, message),
            (state) => ({ ...state, updatedAt: Date.now() }));
        }
        // Existing queued/failed/sending/sent records are never reset by retry.
        result(undefined);
      });
      request.onsuccess = complete; deleted.onsuccess = complete; unsent.onsuccess = complete;
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
      request.onsuccess = guard(() => result(request.result as OutboxEntry[]));
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
          result(summarizeConversations(scope, states.result as LocalConversationState[], visible, outbox.result as OutboxEntry[])));
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
          && JSON.stringify(state.projection) !== JSON.stringify(projection)) throw new Error("Conversation revision conflict");
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

  async function claimNextOutgoing(): Promise<OutgoingAttempt | null> {
    return transaction("readwrite", (tx, result, guard) => {
      const outbox = tx.objectStore("outbox");
      const cursor = outbox.openCursor();
      cursor.onsuccess = guard(() => {
        const current = cursor.result;
        if (!current) { result(null); return; }
        const entry = current.value as OutboxEntry;
        const now = Date.now();
        if (entry.status === "SENDING" && (entry.leaseUntil ?? Infinity) > now) {
          current.continue(); return;
        }
        const request = tx.objectStore("messages").get(entry.messageId);
        request.onsuccess = guard(() => {
          const message = request.result as StoredHumanMessage | undefined;
          if (!message || message.server) throw new Error("Messaging outbox identity conflict");
          const token = crypto.randomUUID();
          const attempts = entry.attempts + 1;
          outbox.put({ messageId: entry.messageId, status: "SENDING", attempts, token, leaseUntil: now + LEASE_MS } satisfies OutboxEntry);
          result({ message: copyMessage(message), token, attempt: attempts });
        });
      });
    });
  }

  async function failOutgoing(input: OutgoingAttempt): Promise<boolean> {
    assertOpen();
    const message = copyMessage(input.message);
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
          outbox.put({ messageId: message.id, status: "FAILED", attempts: attempt } satisfies OutboxEntry);
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
    const message = copyMessage(input.event.message);
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
            const existing = request.result as StoredHumanMessage | undefined;
            // Anti-resurrection: the mailbox receipt and the message row are
            // written in one strict transaction, so a recorded envelope with no
            // stored row means the local history was deliberately deleted. A
            // replay may acknowledge identity, never restore content or the
            // conversation entry.
            if (existingMailbox && !existing) { result(receipt); return; }
            const tombstone = removed.result as MessageStateChange | undefined;
            const deletion = deleted.result as MessageStateChange | undefined;
            for (const state of [tombstone, deletion]) {
              if (state && (state.kind === "CLEAR_FOR_ME" || state.conversationId !== message.conversationId
                || state.authorId !== message.authorId || state.recipientId !== message.recipientId
                || state.messageSequence !== sequence)) throw new Error("Erasure message identity conflict");
            }
            const suppressed = !!deletion || sequence <= ((clear.result as { throughSequence: number } | undefined)?.throughSequence ?? 0);
            if (existing && (existing.id !== message.id || existing.conversationId !== message.conversationId
              || existing.authorId !== message.authorId || existing.recipientId !== message.recipientId
              || (!tombstone && !suppressed && !sameMessage(existing, message)))) throw new Error("Immutable message conflict");
            if (existing?.server && (existing.server.eventId !== eventId || existing.server.sequence !== sequence)) {
              throw new Error("Immutable message event conflict");
            }
            if (!existingEvent) events.add({ eventId, conversationId: message.conversationId, sequence, messageId: message.id } satisfies EventIdentity);
            const stored: StoredHumanMessage = { ...message, server: { eventId, sequence },
              ...((tombstone || suppressed) ? { body: "" } : {}),
              ...(tombstone ? { unsentAt: tombstone.occurredAt } : {}) };
            if (!existing) messages.add(stored);
            else if (!existing.server || tombstone || suppressed) messages.put(stored);
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
            if (message.server && message.server.sequence <= change.throughSequence) entry.update({ ...message, body: "" });
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
              const prior = source as MessageStateChange | undefined;
              if (prior && (prior.kind === "CLEAR_FOR_ME" || prior.conversationId !== change.conversationId
                || prior.authorId !== change.authorId || prior.recipientId !== change.recipientId
                || prior.messageSequence !== change.messageSequence)) throw new Error("Erasure message identity conflict");
            }
            const existing = request.result as StoredHumanMessage | undefined;
            if (existing && (existing.conversationId !== change.conversationId || existing.authorId !== change.authorId
              || existing.recipientId !== change.recipientId
              || (existing.server && existing.server.sequence !== change.messageSequence))) {
              throw new Error("Messaging state message identity conflict");
            }
            if (change.kind === "DELETE_FOR_ME") tx.objectStore("deletions").put(change);
            else tx.objectStore("unsends").put(change);
            messages.put({ id: change.messageId, conversationId: change.conversationId,
                authorId: change.authorId, recipientId: change.recipientId, body: "",
                ...(existing?.server ? { server: existing.server } : {}),
                ...(existing?.unsentAt !== undefined ? { unsentAt: existing.unsentAt }
                  : change.kind === "UNSEND" ? { unsentAt: change.occurredAt } : {}) } satisfies StoredHumanMessage);
            tx.objectStore("outbox").delete(change.messageId);
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
    const receipt = await persistInbound(envelope);
    assertOpen(); // Sign-out between commit and ACK fails closed; replay can ACK later.
    await ack(receipt);
  }

  // Loud, not silent: a backup restored into the web adapter must fail visibly
  // rather than appear to succeed while dropping history.
  function exportSnapshot(): Promise<never> {
    return Promise.reject(new Error("Messaging backup is not implemented for IndexedDB yet"));
  }
  function importSnapshot(): Promise<never> {
    return Promise.reject(new Error("Messaging backup is not implemented for IndexedDB yet"));
  }

  return { enqueueOutgoing, getMessage, listMessages, listConversations, cacheConversation,
    markConversationRead, getStateCursor, applyStateChange, listOutbox, claimNextOutgoing, failOutgoing, persistInbound, persistInboundAndAck, close,
    exportSnapshot, importSnapshot };
}
