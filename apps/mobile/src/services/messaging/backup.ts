/**
 * Portable private-chat history backup (R3 §7–§10).
 *
 * A backup is a **snapshot of accepted history**, not a database image: no
 * mailbox receipts, no outbox and no per-device read state. Restoring one must
 * never create send work, fabricate a server acknowledgement, or bring back a
 * body the user suppressed.
 *
 * ## Integrity is not authenticity
 *
 * The digest is unkeyed SHA-256 over the canonical envelope. It detects
 * corruption and accidental mixing of two files; it does **not** detect forgery,
 * because anyone can recompute it. Every record is therefore validated on its own
 * terms as if the digest had passed on an attacker's file, and the account check
 * is the only cross-account guard. Authorization and encryption belong to the
 * transport (Drive), not to this module.
 *
 * ## Merge is commutative
 *
 * Every merge rule is min, max, union, or "suppressed wins", so merging A into B
 * and B into A reach the same state. Timestamps are the only place this is subtle:
 * conversation timestamps are display metadata (SQLite derives `created_at` from
 * local `now()`), so they merge as min/max rather than being compared as identity.
 */
import type {
  HistorySnapshot, ImportReport, MessagingHistory, MessagingScope, SnapshotMessage,
} from "./history";
import { isUuid, MAX_BODY_UNITS } from "./validation";

export type {
  HistorySnapshot, ImportReport, SnapshotConversation, SnapshotMessage,
} from "./history";

export const BACKUP_FORMAT = "findback.chat.backup";
export const BACKUP_VERSION = 1;

export interface HistoryBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  accountId: string;
  deviceId: string;
  exportedAt: number;
  snapshot: HistorySnapshot;
  digest: string;
}

export type BackupErrorCode =
  | "backup: not an object"
  | "backup: unsupported format"
  | "backup: unsupported version"
  | "backup: account mismatch"
  | "backup: digest mismatch"
  | "backup: invalid snapshot"
  | "backup: identity conflict";

export class BackupError extends Error {
  constructor(public code: BackupErrorCode) {
    super(code);
    this.name = "BackupError";
  }
}

/** Canonicalise JSON-compatible objects before hashing, retaining array order. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => [key, normalize(val)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export async function digestOf(backup: Omit<HistoryBackup, "digest">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(backup));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/**
 * `Array.prototype.every` skips holes, so `Array(1)` would satisfy every record
 * check while `for...of` later yields `undefined`. A backup must be a plain, dense
 * array: every index present and no extra enumerable keys, so a hole cannot be
 * compensated for by adding a property of its own.
 */
function dense(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const length = value.length;
  if (Object.keys(value).length !== length) return false;
  for (let index = 0; index < length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

/**
 * The exact own-key set of each record type and of the envelope.
 *
 * `readSnapshot` rebuilds records field by field, so an unknown key would be
 * silently dropped and the digest over the copy would no longer match a
 * correctly sealed file — reported as `digest mismatch` when the real problem is
 * an unknown field. Rejecting the key up front keeps the copy byte-identical for
 * every input this module accepts, and keeps the error classification honest.
 */
const ENVELOPE_KEYS = ["format", "version", "accountId", "deviceId", "exportedAt", "snapshot", "digest"];
const CONVERSATION_KEYS = ["id", "lastSequence", "createdAt", "updatedAt"];
const MESSAGE_KEYS = ["id", "conversationId", "authorId", "recipientId", "body",
  "serverEventId", "serverSequence", "unsentAt", "createdAt"];
const TOMBSTONE_KEYS = ["messageId", "conversationId", "recipientId", "unsentAt", "unsentBy"];
const DELETION_KEYS = ["messageId", "conversationId", "deletedAt"];
const CLEAR_KEYS = ["conversationId", "throughSequence", "clearedAt"];

const SNAPSHOT_KEYS = ["conversations", "messages", "tombstones", "deletedForMe", "clears"];

/** Distinguishes "no own data value" from a field whose value is `undefined`. */
const ABSENT = Symbol("absent");

/**
 * Read one **own data** property without invoking anything.
 *
 * `row.key` follows the prototype chain and can be answered by a getter, and a
 * Proxy can report a name through `ownKeys`/`getOwnPropertyDescriptor` while
 * ordinary reads still resolve through its target's prototype. Neither an
 * `Object.keys` check nor `hasOwnProperty` distinguishes those from real own
 * data, because both are questions the object itself answers.
 *
 * A descriptor is the only statement the object makes about a *value it owns*:
 * an inherited field has no own descriptor at all, and an accessor's descriptor
 * has `get`/`set` instead of `value`. Reading descriptors therefore copies the
 * data the caller declared and can never execute caller code.
 */
function ownData(target: object, key: string): unknown | typeof ABSENT {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !("value" in descriptor)) return ABSENT;
  return descriptor.value;
}

function ownField(target: object, key: string): unknown {
  const value = ownData(target, key);
  if (value === ABSENT) throw new BackupError("backup: invalid snapshot");
  return value;
}

/**
 * A record is exactly its schema: the same set of own string keys, each one an
 * own data property.
 *
 * The key set is compared by count as well as by name, so an extra own key is
 * rejected rather than silently dropped — a dropped key would make the copy
 * hash differently and be reported as `digest mismatch` when the real problem is
 * an unknown field. Symbols cannot come from JSON and are rejected too.
 */
function exactKeys(row: object, allowed: readonly string[]): boolean {
  const own = Reflect.ownKeys(row);
  if (own.length !== allowed.length) return false;
  return own.every((key) => typeof key === "string" && allowed.includes(key));
}

/**
 * Copy a caller-supplied array through own data descriptors.
 *
 * `Array.prototype.map` reads elements by ordinary property access, which a
 * Proxy can answer from its target's prototype, and `every` skips holes. The
 * index set is therefore checked exactly — every index present, and nothing but
 * indices and `length` — and each element is taken from its own descriptor.
 */
function elements(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new BackupError("backup: invalid snapshot");
  // `length` is read from its descriptor too. `value.length` is an ordinary
  // read, and a Proxy around an array can answer `0` from a `get` trap while its
  // target holds elements — the copy would then be an empty array and the
  // supplied rows would vanish without any error.
  const declared = ownData(value, "length");
  if (declared === ABSENT || !Number.isSafeInteger(declared) || (declared as number) < 0) {
    throw new BackupError("backup: invalid snapshot");
  }
  const length = declared as number;
  if (Reflect.ownKeys(value).length !== length + 1) {
    throw new BackupError("backup: invalid snapshot");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = ownData(value, String(index));
    if (element === ABSENT) throw new BackupError("backup: invalid snapshot");
    out.push(element);
  }
  return out;
}

function validBody(value: unknown): boolean {
  return value === null
    || (typeof value === "string" && !!value.trim() && value.length <= MAX_BODY_UNITS
      && !value.includes("\u0000"));
}

/**
 * Read caller-supplied data exactly once into plain records.
 *
 * This is the module's only read of a caller-owned snapshot. Everything
 * downstream — the digest, the record checks, the merge — works on this copy,
 * so a stateful accessor cannot answer one value to validation and a different
 * one to the import, and cannot throw in a place that is not guarded. Any trap
 * it does raise becomes `backup: invalid snapshot`.
 *
 * Values are copied verbatim, never normalised: the digest is computed over this
 * copy, so it must be byte-identical to what the caller sealed.
 */
function readSnapshot(value: unknown): HistorySnapshot {
  try {
    if (!object(value)) throw new BackupError("backup: invalid snapshot");
    if (!exactKeys(value, SNAPSHOT_KEYS)) throw new BackupError("backup: invalid snapshot");
    const conversations = elements(ownField(value, "conversations"));
    const messages = elements(ownField(value, "messages"));
    const tombstones = elements(ownField(value, "tombstones"));
    const deletedForMe = elements(ownField(value, "deletedForMe"));
    const clears = elements(ownField(value, "clears"));
    // The casts are not assumptions: `checkSnapshot` validates this copy before
    // anything uses it, and a cast here cannot throw on hostile input.
    const record = (row: unknown, allowed: readonly string[]): Record<string, unknown> => {
      if (!object(row)) throw new BackupError("backup: invalid snapshot");
      if (!exactKeys(row, allowed)) throw new BackupError("backup: invalid snapshot");
      const copy: Record<string, unknown> = {};
      for (const key of allowed) copy[key] = ownField(row, key);
      return copy;
    };
    return {
      conversations: conversations.map((row) => {
        const r = record(row, CONVERSATION_KEYS);
        return {
          id: r.id as string,
          lastSequence: r.lastSequence as number,
          createdAt: r.createdAt as number,
          updatedAt: r.updatedAt as number,
        };
      }),
      messages: messages.map((row) => {
        const r = record(row, MESSAGE_KEYS);
        return {
          id: r.id as string,
          conversationId: r.conversationId as string,
          authorId: r.authorId as string,
          recipientId: r.recipientId as string,
          body: r.body as string | null,
          serverEventId: r.serverEventId as string,
          serverSequence: r.serverSequence as number,
          unsentAt: r.unsentAt as number | null,
          createdAt: r.createdAt as number | null,
        };
      }),
      tombstones: tombstones.map((row) => {
        const r = record(row, TOMBSTONE_KEYS);
        return {
          messageId: r.messageId as string,
          conversationId: r.conversationId as string,
          recipientId: r.recipientId as string | null,
          unsentAt: r.unsentAt as number,
          unsentBy: r.unsentBy as string,
        };
      }),
      deletedForMe: deletedForMe.map((row) => {
        const r = record(row, DELETION_KEYS);
        return {
          messageId: r.messageId as string,
          conversationId: r.conversationId as string | null,
          deletedAt: r.deletedAt as number,
        };
      }),
      clears: clears.map((row) => {
        const r = record(row, CLEAR_KEYS);
        return {
          conversationId: r.conversationId as string,
          throughSequence: r.throughSequence as number,
          clearedAt: r.clearedAt as number,
        };
      }),
    };
  } catch (error) {
    // A caller-supplied object can be hostile: a revoked Proxy makes even
    // `Array.isArray` throw, and a getter can throw at any read. Those must
    // surface as the documented code, not as a raw TypeError.
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup: invalid snapshot");
  }
}

/**
 * Validate every record, not just the envelope. A snapshot is untrusted input:
 * it may have been edited, produced by a future version, or assembled by hand.
 *
 * The copy is validated, not the caller's object, so this cannot pass and then
 * behave differently later. The copy cannot throw, so a throw from here is a
 * genuine defect in this module rather than caller input and is not masked.
 */
export function validateSnapshot(value: unknown, accountId: string): asserts value is HistorySnapshot {
  checkSnapshot(readSnapshot(value), accountId);
}

function checkSnapshot(value: unknown, accountId: string): asserts value is HistorySnapshot {
  if (!object(value)) throw new BackupError("backup: invalid snapshot");
  const { conversations, messages, tombstones, deletedForMe, clears } = value;
  if (!dense(conversations) || !dense(messages) || !dense(tombstones)
    || !dense(deletedForMe) || !dense(clears)) {
    throw new BackupError("backup: invalid snapshot");
  }
  if (!conversations.every((row: unknown) => object(row) && isUuid(row.id)
    && integer(row.lastSequence) && integer(row.createdAt) && integer(row.updatedAt))) {
    throw new BackupError("backup: invalid snapshot");
  }
  if (!messages.every((row: unknown) => object(row) && isUuid(row.id) && isUuid(row.conversationId)
    && isUuid(row.authorId) && isUuid(row.recipientId) && row.authorId !== row.recipientId
    && (row.authorId === accountId || row.recipientId === accountId)
    && validBody(row.body)
    && isUuid(row.serverEventId) && integer(row.serverSequence, 1)
    && (row.unsentAt === null || integer(row.unsentAt, 1))
    && (row.createdAt === null || integer(row.createdAt)))) {
    throw new BackupError("backup: invalid snapshot");
  }
  if (!tombstones.every((row: unknown) => object(row) && isUuid(row.messageId)
    && isUuid(row.conversationId) && isUuid(row.unsentBy) && integer(row.unsentAt, 1)
    && (row.recipientId === null || isUuid(row.recipientId))
    && (row.recipientId === null
      || (row.unsentBy !== row.recipientId
        && (row.unsentBy === accountId || row.recipientId === accountId))))) {
    throw new BackupError("backup: invalid snapshot");
  }
  if (!deletedForMe.every((row: unknown) => object(row) && isUuid(row.messageId)
    && (row.conversationId === null || isUuid(row.conversationId))
    && integer(row.deletedAt, 1))) {
    throw new BackupError("backup: invalid snapshot");
  }
  if (!clears.every((row: unknown) => object(row) && isUuid(row.conversationId)
    && integer(row.throughSequence, 1) && integer(row.clearedAt, 1))) {
    throw new BackupError("backup: invalid snapshot");
  }
}

/**
 * Resolve the one field that genuinely differs between adapters: the web store
 * never observed a message timestamp. `0` means "unknown, never observed" — a
 * constant, so it cannot make the merge direction-dependent.
 *
 * Accepted messages carry a unique `server_sequence` and are ordered by it first,
 * so `created_at` only ever breaks ties that cannot exist. Mapping to `0` is
 * therefore invisible to `listMessages` and never invents a wall-clock time.
 */
export function normaliseSnapshot(value: unknown): HistorySnapshot {
  // One guarded read, then work only on the copy: the caller's object is never
  // touched again, so an accessor cannot change a value after it was read.
  const snapshot = readSnapshot(value);
  if (snapshot.conversations.some((row) => !integer(row.createdAt) || !integer(row.updatedAt))) {
    throw new BackupError("backup: invalid snapshot");
  }
  return {
    ...snapshot,
    messages: snapshot.messages.map((message: SnapshotMessage) => ({
      ...message,
      createdAt: message.createdAt ?? 0,
    })),
  };
}

export async function decodeBackup(raw: string | unknown): Promise<HistoryBackup> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new BackupError("backup: not an object");
    }
  }
  try {
    // Inside the guard: `object()` calls `Array.isArray`, which throws on a
    // revoked Proxy, so the check itself is a read of caller data.
    if (!object(value)) throw new BackupError("backup: not an object");
    return await decodeEnvelope(value);
  } catch (error) {
    // A caller-supplied object can be hostile: a revoked Proxy makes even
    // `Array.isArray` throw, and a getter can throw at any read. Those must
    // surface as the documented code, not as a raw TypeError.
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup: invalid snapshot");
  }
}

async function decodeEnvelope(value: object): Promise<HistoryBackup> {
  // Read each field exactly once into locals, through its own descriptor. The
  // digest, the account check and the returned envelope must all describe the
  // same bytes, and none of them may execute caller code to obtain them.
  const field = (key: string): unknown => ownData(value, key);
  const format = field("format");
  const version = field("version");
  const digest = field("digest");
  const accountId = field("accountId");
  const deviceId = field("deviceId");
  const exportedAt = field("exportedAt");
  if (format !== BACKUP_FORMAT) throw new BackupError("backup: unsupported format");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1
    || version > BACKUP_VERSION) {
    throw new BackupError("backup: unsupported version");
  }
  // Format and version are checked first so a foreign envelope is reported as
  // one, rather than as an invalid snapshot because its keys do not match ours.
  if (!exactKeys(value, ENVELOPE_KEYS)) throw new BackupError("backup: invalid snapshot");
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new BackupError("backup: digest mismatch");
  }
  // The single guarded read of the snapshot: the digest is computed over this
  // copy and the copy is what gets validated and returned.
  const snapshot = readSnapshot(field("snapshot"));
  const envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    accountId: accountId as string,
    deviceId: deviceId as string,
    exportedAt: exportedAt as number,
    snapshot,
  } as const;
  // Shape and record checks come before the digest comparison, because the copy
  // drops keys the caller invented and would otherwise turn a malformed record
  // into a misleading "digest mismatch". Nothing is used before the digest
  // matches; this only decides which documented code the caller sees.
  if (!isUuid(accountId) || !isUuid(deviceId) || !integer(exportedAt, 1)) {
    throw new BackupError("backup: invalid snapshot");
  }
  checkSnapshot(snapshot, accountId);
  let computed: string;
  try {
    computed = await digestOf(envelope);
  } catch {
    throw new BackupError("backup: invalid snapshot");
  }
  if (computed !== digest) throw new BackupError("backup: digest mismatch");
  return { ...envelope, digest };
}

export async function createBackup(
  history: MessagingHistory,
  scope: MessagingScope,
  now: number,
): Promise<HistoryBackup> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new BackupError("backup: invalid snapshot");
  // One guarded read of the adapter's export, then everything — validation, the
  // digest and the returned backup — uses that same plain copy. Validating a
  // copy and then hashing the original would let a stateful export answer one
  // body to the check and another to the file.
  const snapshot = normaliseSnapshot(await history.exportSnapshot());
  validateSnapshot(snapshot, scope.accountId);
  const envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    accountId: scope.accountId,
    deviceId: scope.deviceId,
    exportedAt: now,
    snapshot,
  } as const;
  return { ...envelope, digest: await digestOf(envelope) };
}

export function encodeBackup(backup: HistoryBackup): string {
  return JSON.stringify(backup);
}

/**
 * Decode, check the account binding, and merge. The snapshot is normalised here
 * so the adapter never needs to know about the envelope or its export time.
 */
export async function restoreBackup(
  history: MessagingHistory,
  scope: MessagingScope,
  raw: string | unknown,
): Promise<ImportReport> {
  const backup = await decodeBackup(raw);
  if (backup.accountId !== scope.accountId) throw new BackupError("backup: account mismatch");
  return history.importSnapshot(normaliseSnapshot(backup.snapshot));
}
