// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BackupError, canonicalJson, createBackup, decodeBackup, digestOf, encodeBackup,
  normaliseSnapshot, validateSnapshot,
} from "./backup";
import type { HistorySnapshot, MessagingHistory } from "./history";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const DEVICE = "00000000-0000-4000-8000-000000000004";
const CONVERSATION = "00000000-0000-4000-8000-000000000006";
const MESSAGE = "00000000-0000-4000-8000-000000000008";
const EVENT = "00000000-0000-4000-8000-00000000000a";
const PEER = "00000000-0000-4000-8000-000000000002";

function emptySnapshot(): HistorySnapshot {
  return { conversations: [], messages: [], tombstones: [], deletedForMe: [], clears: [] };
}

async function sealed(snapshot: HistorySnapshot = emptySnapshot(), overrides: Record<string, unknown> = {}) {
  const envelope = {
    format: "findback.chat.backup" as const, version: 1, accountId: ACCOUNT,
    deviceId: DEVICE, exportedAt: 1_700_000_000_000, snapshot, ...overrides,
  };
  return { ...envelope, digest: await digestOf(envelope as Parameters<typeof digestOf>[0]) };
}

describe("portable history backup envelope", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: 0 })).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
  });

  it("rejects malformed envelopes with stable errors", async () => {
    for (const [raw, code] of [
      ["not JSON", "backup: not an object"],
      [null, "backup: not an object"],
      [{}, "backup: unsupported format"],
      [{ format: "other" }, "backup: unsupported format"],
      [{ format: "findback.chat.backup", version: 2 }, "backup: unsupported version"],
      [{ format: "findback.chat.backup", version: 0 }, "backup: unsupported version"],
    ] as const) {
      await expect(decodeBackup(raw)).rejects.toMatchObject({ code });
    }
  });

  it("rejects a modified snapshot after digest sealing", async () => {
    const envelope = await sealed();
    await expect(decodeBackup({ ...envelope, exportedAt: envelope.exportedAt + 1 }))
      .rejects.toMatchObject({ code: "backup: digest mismatch" });
  });

  it("accepts a correctly sealed envelope", async () => {
    await expect(decodeBackup(await sealed())).resolves.toMatchObject({ accountId: ACCOUNT });
  });

  it("rejects malformed snapshot records even when their digest is valid", async () => {
    const cases: unknown[] = [
      [null],
      [{ id: "bad" }],
      [{ id: 1 }],
      // A body that is empty or whitespace cannot be a real message body; the
      // adapters use that representation for "suppressed", which a backup must
      // carry as null, never as an empty string.
      [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
        body: "   ", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: null,
      }],
      // A message whose participants do not include the backup account.
      [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: PEER,
        body: "x", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: null,
      }],
      // Sequence 0 is not a positive server sequence.
      [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
        body: "x", serverEventId: EVENT, serverSequence: 0, unsentAt: null, createdAt: null,
      }],
    ];
    for (const messages of cases) {
      const snapshot = { ...emptySnapshot(), messages } as unknown as HistorySnapshot;
      const envelope = await sealed(snapshot);
      await expect(decodeBackup(envelope)).rejects.toMatchObject({ code: "backup: invalid snapshot" });
    }
  });

  it("rejects a conversation with an unknown creation time", async () => {
    const snapshot = {
      ...emptySnapshot(),
      conversations: [{ id: CONVERSATION, lastSequence: 1, createdAt: null, updatedAt: 1 }],
    } as unknown as HistorySnapshot;
    expect(() => normaliseSnapshot(snapshot)).toThrow("backup: invalid snapshot");
    await expect(decodeBackup(await sealed(snapshot)))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("normalises an unknown message timestamp to the constant zero", () => {
    const snapshot: HistorySnapshot = {
      ...emptySnapshot(),
      messages: [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
        body: "x", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: null,
      }],
    };
    expect(normaliseSnapshot(snapshot).messages[0]?.createdAt).toBe(0);
    // A known value is preserved, and normalisation is idempotent.
    const known = { ...snapshot, messages: [{ ...snapshot.messages[0]!, createdAt: 99 }] };
    expect(normaliseSnapshot(known).messages[0]?.createdAt).toBe(99);
    expect(normaliseSnapshot(normaliseSnapshot(known))).toEqual(normaliseSnapshot(known));
  });

  it("rejects a sparse record array instead of letting it through", async () => {
    // `Array.prototype.every` skips holes, so a sparse array used to pass every
    // record check and then fail later as a raw TypeError inside the adapter.
    for (const key of ["conversations", "messages", "tombstones", "deletedForMe", "clears"] as const) {
      const snapshot = { ...emptySnapshot(), [key]: Array(1) } as unknown as HistorySnapshot;
      expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
      await expect(decodeBackup(await sealed(snapshot)))
        .rejects.toMatchObject({ code: "backup: invalid snapshot" });
    }
  });

  it("rejects a hole compensated for by an extra property", async () => {
    // `Array(1)` with one extra key has matching length and key count, so the
    // simple density check would pass while index 0 is still missing.
    const sparse = Array(1) as unknown[] & { extra?: boolean };
    sparse.extra = true;
    const snapshot = { ...emptySnapshot(), messages: sparse } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
  });

  it("maps a revoked proxy used as the whole envelope to the documented error", async () => {
    // The outer object check itself calls `Array.isArray`, which throws on a
    // revoked Proxy, so it has to sit inside the guard too.
    const revocable = Proxy.revocable<Record<string, unknown>>({}, {});
    revocable.revoke();
    await expect(decodeBackup(revocable.proxy)).rejects.toBeInstanceOf(BackupError);
  });

  it("rejects an unknown record key instead of reporting a digest mismatch", async () => {
    // The copy keeps only known fields, so a sealed record with an extra key
    // would otherwise hash differently and look like tampering.
    const message = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000, futureField: "extension",
    };
    const snapshot = { ...emptySnapshot(), messages: [message] } as unknown as HistorySnapshot;
    await expect(decodeBackup(await sealed(snapshot)))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("does not let an array proxy hide its rows behind a forged length", () => {
    // `value.length` is an ordinary read: a `get` trap can answer 0 while the
    // target holds a row, so the copy would be an empty array and the supplied
    // rows would vanish with no error. The length is read from its own
    // descriptor and must agree with the reported index set.
    const row = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000,
    };
    const hidden = new Proxy([row], {
      get(target, key, receiver) {
        return key === "length" ? 0 : Reflect.get(target, key, receiver);
      },
      ownKeys: () => ["length"],
    });
    // The forgery is real: ordinary reads say empty, the descriptor does not.
    expect(hidden.length).toBe(0);
    expect(Reflect.ownKeys(hidden)).toEqual(["length"]);
    expect(Object.getOwnPropertyDescriptor(hidden, "length")!.value).toBe(1);

    const snapshot = { ...emptySnapshot(), messages: hidden } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    expect(() => normaliseSnapshot(snapshot)).toThrow(BackupError);
  });

  it("rejects an unknown snapshot-level key instead of reporting a digest mismatch", async () => {
    // The same rule one level up: the snapshot object is part of the sealed
    // envelope, so a dropped key would change the digest and be blamed on
    // tampering rather than on the unknown field.
    const snapshot = { ...emptySnapshot(), future: true } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    await expect(decodeBackup(await sealed(snapshot)))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("rejects a record whose fields live on its prototype", async () => {
    // `Object.keys` sees own keys only, so a prototype-built record has none and
    // would pass a "no unknown keys" test while every field is inherited.
    const prototype = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000,
    };
    const inherited = Object.create(prototype) as Record<string, unknown>;
    expect(Object.keys(inherited)).toEqual([]);

    const snapshot = { ...emptySnapshot(), messages: [inherited] } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    await expect(decodeBackup(await sealed(snapshot)))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("rejects an envelope whose fields live on its prototype", async () => {
    // Nothing is owned, so there is no format to recognise.
    const envelope = await sealed();
    const inherited = Object.create(envelope) as Record<string, unknown>;
    await expect(decodeBackup(inherited)).rejects.toMatchObject({ code: "backup: unsupported format" });

    // Own format and version, inherited everything else: the format is valid and
    // the key set is not, which is the case the own-property rule exists for.
    const partial = Object.create(envelope) as Record<string, unknown>;
    Object.assign(partial, { format: envelope.format, version: envelope.version });
    await expect(decodeBackup(partial)).rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("still accepts a null-prototype record that owns every field", async () => {
    // The rule is "own properties", not "a particular prototype": JSON.parse
    // output and `Object.create(null)` records are both fine.
    const message = Object.assign(Object.create(null) as Record<string, unknown>, {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000,
    });
    const snapshot = { ...emptySnapshot(), messages: [message] } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).not.toThrow();
    await expect(decodeBackup(await sealed(snapshot))).resolves.toMatchObject({ accountId: ACCOUNT });
  });

  it("rejects an unknown envelope key", async () => {
    const envelope = await sealed();
    await expect(decodeBackup({ ...envelope, extra: true }))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
  });

  it("refuses an adapter export that supplies a field through an accessor, without running it", async () => {
    // A serialized backup has no accessors, so an accessor is not data this
    // module can vouch for. Rejecting it is stronger than reading it once: no
    // caller code runs inside the guard at all.
    let reads = 0;
    const message = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      get body(): string {
        reads += 1;
        return "Reply text";
      },
      serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: 1_700_000_000_000,
    };
    const history = {
      exportSnapshot: async () => ({ ...emptySnapshot(), messages: [message] }),
    } as unknown as MessagingHistory;

    await expect(createBackup(history, { accountId: ACCOUNT, deviceId: DEVICE }, 1_700_000_000_000))
      .rejects.toMatchObject({ code: "backup: invalid snapshot" });
    expect(reads).toBe(0);
  });

  it("returns its own copy of the export, so a later caller mutation cannot change it", async () => {
    const exported = {
      ...emptySnapshot(),
      messages: [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
        body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
        createdAt: 1_700_000_000_000,
      }],
    };
    const history = { exportSnapshot: async () => exported } as unknown as MessagingHistory;

    const backup = await createBackup(history, { accountId: ACCOUNT, deviceId: DEVICE }, 1_700_000_000_000);
    expect(backup.snapshot).not.toBe(exported);
    expect(backup.snapshot.messages[0]).not.toBe(exported.messages[0]);
    exported.messages[0]!.body = "Changed after the fact";
    expect(backup.snapshot.messages[0]!.body).toBe("Reply text");
    // The returned backup is plain data, so it survives its own round trip.
    await expect(decodeBackup(encodeBackup(backup))).resolves.toMatchObject({ accountId: ACCOUNT });
  });

  it("maps a hostile object trap to the documented error", async () => {
    // A revoked Proxy makes even `Array.isArray` throw. That must not surface as
    // a raw TypeError from a public entry point.
    const revocable = Proxy.revocable<unknown[]>(Array(0), {});
    revocable.revoke();
    const snapshot = { ...emptySnapshot(), conversations: revocable.proxy } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    const envelope = {
      format: "findback.chat.backup" as const, version: 1, accountId: ACCOUNT,
      deviceId: DEVICE, exportedAt: 1_700_000_000_000, snapshot, digest: "0".repeat(64),
    };
    await expect(decodeBackup(envelope)).rejects.toBeInstanceOf(BackupError);
  });

  it("never invokes an accessor on caller data", () => {
    // An accessor is caller code. Rejecting it is stronger than reading it once:
    // nothing the caller wrote runs, so no value can differ between the check
    // and the merge.
    let reads = 0;
    const message = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      get body(): string {
        reads += 1;
        return "Reply text";
      },
      serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: 1_700_000_000_000,
    };
    const snapshot = { ...emptySnapshot(), messages: [message] } as unknown as HistorySnapshot;
    expect(() => normaliseSnapshot(snapshot)).toThrow(BackupError);
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    expect(reads).toBe(0);
  });

  it("reads each field through exactly one descriptor call, so a trap cannot answer twice", () => {
    // The copy is built from `getOwnPropertyDescriptor`, so a trap that would
    // answer one value to the check and another to the merge is never asked
    // twice: there is only the one read.
    let bodyReads = 0;
    const target = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "Reply text", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000,
    };
    const stateful = new Proxy(target, {
      getOwnPropertyDescriptor(row, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(row, key);
        if (key !== "body" || !descriptor) return descriptor;
        bodyReads += 1;
        return { ...descriptor, value: bodyReads === 1 ? "Reply text" : "Resurrected" };
      },
    });
    const snapshot = { ...emptySnapshot(), messages: [stateful] } as unknown as HistorySnapshot;
    expect(normaliseSnapshot(snapshot).messages[0]!.body).toBe("Reply text");
    expect(bodyReads).toBe(1);
  });

  it("refuses a throwing accessor without running it", () => {
    let reads = 0;
    const message = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      get body(): string { reads += 1; throw new Error("hostile accessor"); },
      serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: 1,
    };
    const snapshot = { ...emptySnapshot(), messages: [message] } as unknown as HistorySnapshot;
    expect(() => validateSnapshot(snapshot, ACCOUNT)).toThrow(BackupError);
    expect(() => normaliseSnapshot(snapshot)).toThrow(BackupError);
    expect(reads).toBe(0);
  });

  it("does not copy a value a proxy reports as own but reads from its prototype", () => {
    // Luna's counterexample: `ownKeys` and `getOwnPropertyDescriptor` can report
    // the schema names, so `Object.keys` and `hasOwnProperty` both say "own",
    // while ordinary reads still resolve through the target's prototype. A Proxy
    // cannot be told apart from a plain object, so the only safe answer is to
    // take no value from an ordinary read at all.
    const inherited = {
      id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
      body: "INHERITED", serverEventId: EVENT, serverSequence: 1, unsentAt: null,
      createdAt: 1_700_000_000_000,
    };
    const owned = { ...inherited, body: "OWNED" };
    const spoof = new Proxy(Object.create(inherited) as Record<string, unknown>, {
      ownKeys: () => Object.keys(owned),
      getOwnPropertyDescriptor: (_row, key) => (typeof key === "string" && key in owned
        ? { value: owned[key as keyof typeof owned], enumerable: true, configurable: true, writable: true }
        : undefined),
    });
    // The spoof defeats every check the previous fix relied on.
    expect(Object.keys(spoof)).toEqual(Object.keys(owned));
    expect(Object.prototype.hasOwnProperty.call(spoof, "body")).toBe(true);
    expect(spoof.body).toBe("INHERITED");

    const snapshot = { ...emptySnapshot(), messages: [spoof] } as unknown as HistorySnapshot;
    expect(normaliseSnapshot(snapshot).messages[0]!.body).toBe("OWNED");
  });

  it("validates a snapshot against the account it claims", () => {
    const snapshot: HistorySnapshot = {
      ...emptySnapshot(),
      messages: [{
        id: MESSAGE, conversationId: CONVERSATION, authorId: PEER, recipientId: ACCOUNT,
        body: "x", serverEventId: EVENT, serverSequence: 1, unsentAt: null, createdAt: null,
      }],
    };
    expect(() => validateSnapshot(snapshot, ACCOUNT)).not.toThrow();
    // The same records under a different account are not this account's history.
    expect(() => validateSnapshot(snapshot, DEVICE)).toThrow(BackupError);
  });
});
