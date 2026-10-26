import type {
  HumanMessage, MailboxEnvelope, MessagingHistory, MessagingScope,
  OutboxEntry, OutgoingAttempt, PersistenceReceipt, StoredHumanMessage,
} from "./history";
import { copyMessage, sameMessage, uuid } from "./validation";

const STORES = ["messages", "outbox", "events", "mailbox"];
const LEASE_MS = 60_000;

interface EventIdentity {
  eventId: string;
  conversationId: string;
  sequence: number;
  messageId: string;
}

function connect(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    let rejected = false;
    request.onblocked = () => {
      rejected = true;
      reject(new Error("Messaging storage upgrade blocked"));
    };
    request.onerror = () => reject(new Error("Messaging storage could not open"));
    request.onupgradeneeded = () => {
      const db = request.result;
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("conversation", "conversationId");
      db.createObjectStore("outbox", { keyPath: "messageId" });
      db.createObjectStore("mailbox", { keyPath: "mailboxId" });
      const events = db.createObjectStore("events", { keyPath: "eventId" });
      events.createIndex("sequence", ["conversationId", "sequence"], { unique: true });
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
      request.onsuccess = guard(() => {
        const existing = request.result as StoredHumanMessage | undefined;
        if (existing && !sameMessage(existing, message)) throw new Error("Immutable message conflict");
        if (!existing) {
          messages.add(message);
          tx.objectStore("outbox").add({ messageId: message.id, status: "QUEUED", attempts: 0 } satisfies OutboxEntry);
        }
        // Existing queued/failed/sending/sent records are never reset by retry.
        result(undefined);
      });
    });
  }

  async function getMessage(id: string): Promise<StoredHumanMessage | null> {
    assertOpen(); uuid(id);
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("messages").get(id);
      request.onsuccess = guard(() => result((request.result as StoredHumanMessage | undefined) ?? null));
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
        result(messages);
      });
    });
  }

  async function listOutbox(): Promise<OutboxEntry[]> {
    return transaction("readonly", (tx, result, guard) => {
      const request = tx.objectStore("outbox").getAll();
      request.onsuccess = guard(() => result(request.result as OutboxEntry[]));
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
          request.onsuccess = guard(() => {
            const existing = request.result as StoredHumanMessage | undefined;
            if (existing && !sameMessage(existing, message)) throw new Error("Immutable message conflict");
            if (existing?.server && (existing.server.eventId !== eventId || existing.server.sequence !== sequence)) {
              throw new Error("Immutable message event conflict");
            }
            if (!existingEvent) events.add({ eventId, conversationId: message.conversationId, sequence, messageId: message.id } satisfies EventIdentity);
            if (!existing) messages.add({ ...message, server: { eventId, sequence } });
            else if (!existing.server) messages.put({ ...message, server: { eventId, sequence } });
            if (!existingMailbox) mailbox.add(receipt);
            // Only this participant-authorized durable echo can confirm server success.
            if (message.authorId === scope.accountId) tx.objectStore("outbox").delete(message.id);
            result(receipt);
          });
        });
      });
    });
  }

  async function persistInboundAndAck(envelope: MailboxEnvelope, ack: (receipt: PersistenceReceipt) => Promise<void>): Promise<void> {
    const receipt = await persistInbound(envelope);
    assertOpen(); // Sign-out between commit and ACK fails closed; replay can ACK later.
    await ack(receipt);
  }

  return { enqueueOutgoing, getMessage, listMessages, listOutbox, claimNextOutgoing, failOutgoing, persistInbound, persistInboundAndAck, close };
}
