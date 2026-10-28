# Human messaging local persistence and relationship policy

This is a **text-only, non-UI messaging service**, independent of AI chat. It is not
full chat or release acceptance. No consumer screen/session-owner caller is wired yet.

## Request and text-delivery service

`createSupabaseMessagingSession(scope, history)` uses the existing auth SDK and
either durable history adapter. The app session owner must call `start(platform)`
to register its random installation identity, and `close()` on sign-out/switch.
There is no new auth owner or automatic in-memory history fallback.

- `request`, `accept`, `end`, `block` call participant-scoped server transitions.
- `send` durably queues immutable text; `flush` retries the same client UUID.
  Only a persisted authoritative mailbox echo clears the outbox; HTTP success
  alone cannot. `sync` processes a bounded page of at most 100 envelopes.
- ACK follows `persistInboundAndAck`, never fetch or an in-memory render. A failed
  ACK leaves an idempotently replayable envelope; a failed durable write sends none.
- Every RPC carries the captured account identity and the server rejects an SDK
  account switch. The server checks the expected recipient before sending.
- SQL enforces initiator-only request messages, recipient-only acceptance, canonical
  private blocks, mutually opted-in CONNECTED receipts, per-device delivery,
  sender echoes and removal of ACKed/expired mailbox payloads. Direct chat table
  grants remain revoked. Legacy non-idempotent send and account-only ACK RPCs are
  revoked in favor of this scoped exchange contract. The idempotent SEND helper is
  internal too: authenticated callers cannot bypass the exchange's device and
  expected-recipient checks by invoking it directly.

This batch does **not** provide consumer screens/navigation, background retry/wake
scheduling, the physical Android SQLite bridge, media, backup/history-gap resend,
or server unsend-tombstone fanout. `first_approach` records the one quiet-request
nudge eligibility; a push worker is not yet connected. Legacy BLOCKED rows remain
quarantined because the old schema did not record who blocked; no unblock direction
is guessed. Permission-first request mode is the only current initiation mode;
open-inbox opt-in remains to be integrated. Receipt privacy is server-enforced,
but a consumer Read-status projection and per-conversation progress are unfinished.

`policy.ts` is pure R3 relationship/safety policy (§2, §3, §11 of the R3 chat
design); `history.ts`/`indexedDbHistory.ts` are the local storage contract and web
adapter. Neither authorizes anything on a server.

## Boundary

`history.ts` is the storage contract for a future SQLite adapter.
`openWebMessagingHistory(scope)` is an explicit web IndexedDB adapter, **not** an
Android storage selector. The session owner supplies signed-in account and random
per-installation UUIDs and must `close()` on sign-out/account switch. Scope is
copied on open; each account/installation has a separate database. Closing aborts
active transactions and invalidates the handle, but intentionally retains local
history for that same identity. It is not an account-deletion/purge implementation.
IndexedDB is origin-local, not an authorization or encryption boundary against
other same-origin code/XSS. There is no hardware fingerprint, localStorage,
in-memory fallback, network access, credential access or message-body logging.

## Durable outgoing text

- Supply a stable client UUID and immutable conversation/author/recipient/body.
  `enqueueOutgoing` atomically adds the message and `QUEUED` outbox entry.
- Reusing the ID with identical content is a no-op even after success. Changed
  immutable content is rejected; retries do not reset pending attempt state.
- `claimNextOutgoing()` atomically acquires a 60-second persisted `SENDING` lease.
  Concurrent handles cannot claim the same live attempt. Crash/reopen does not
  steal another handle's live lease; after expiry the same message ID is retried
  with a new token and attempt number. Wall-clock rollback may delay lease expiry;
  later transport must schedule retries and use server-side idempotency.
- `failOutgoing(attempt)` marks `FAILED` only if the current token/attempt matches.
  Late failures cannot overwrite newer attempts or authoritative success.
- There is no "mark sent" shortcut. Only a validated authoritative TEXT echo with
  identical immutable message fields commits server event metadata and removes
  the outbox in the same transaction. The transport must preserve the client ID.
- Selection among eligible outbox rows is stable UUID order, not FIFO. This slice
  makes no optimistic message-order or UI status promise.

## Inbound authority and ACK

The caller must validate **server authority, actual conversation participants and
target device ownership** before constructing `MailboxEnvelope`. Local checks
reject malformed UUIDs/text, wrong account/install, absent local participant,
unknown event kinds and conflicting stable IDs. They do not authorize unsend,
relationship transitions, privacy settings or mailbox delivery on a server.

`persistInbound` atomically stores message, event identity and mailbox identity,
then returns a receipt **only on transaction completion**. Every write operation
requires the returned transaction to report `durability === "strict"`; silently
default/relaxed, missing or unknown capability aborts before any storage request.
Constructor rejection has no fallback; readonly history remains usable. Accepted
strict is still a browser hint, **not measured disk-flush or power-loss proof**.
Abort/quota/constraint/scope failures reject; none
produces an ACK receipt. `persistInboundAndAck` invokes the supplied callback only
after completion and an open-session check. If ACK fails, committed history is
retained and replay after reopen may ACK safely without duplicate history.
The caller remains responsible for cancelling an already-started network ACK on
session termination. No mailbox cursor is synthesized or advanced.

Event UUID and authoritative positive safe-integer sequence (unique within a
conversation) are immutable. Out-of-order TEXT events are accepted and listed by
sequence, not timestamps. Same mailbox ID cannot refer to a different event.
Returned storage records are IndexedDB clones, not live mutable internal state.
Text is limited to 100,000 UTF-16 code units as a storage-input bound; this is not
request-stage spam enforcement or a user-facing message limit decision.

## Relationship and safety policy (`policy.ts`)

Pure functions over an explicit `PairState`; no clock, network, storage or UI.

- **BLOCK is a hard boundary flag, never a relationship mode.** `blockedBy` is a
  list, so every participant's own choice is preserved independently. A block keeps
  the current REQUEST/CONNECTED mode and is visible only to the participant who
  chose it (`recipientProjection`). It never changes the other participant's own
  controls.
- **Trusted results are separated from what a sender may observe.** `state`,
  `delivery` and `applied` are for the transport only: `state` carries the
  recipient-private `blockedBy`/`hiddenBy` lists, and `delivery`/`applied` carry
  the transport decision. A surface must render `senderVisibleSend` /
  `senderVisibleState`, which structurally exclude all three. Those projections
  derive only from the mode and the local request session, never from which
  negative action the recipient chose, so a blocked send projects exactly like a
  delivered one while its trusted `delivery` is `WITHHOLD`.
- **REQUEST stage**: the initiator may send multiple text-only messages. Media,
  deliberate location share, obvious links and empty bodies are refused. The
  recipient cannot send before accepting. Only the first message of a request
  session reports `nudge: true`; follow-ups stay quiet.
- **Acceptance requires an active request.** `initiatorId` must be non-null and
  must not be the actor. End and Decline clear it, so neither an ended nor a
  declined pair can be self-accepted; a new approach is required.
- **No negative oracle**: `initiatorProjection` depends only on the mode, and the
  sender-visible send/transition projections are identical for decline, hide,
  report and block — including follow-up messages, an initiator's own ACCEPT or End
  attempt, and the receipt view. Decline keeps the request session's nudge state
  (unlike an earlier draft) so the next message's nudge bit cannot distinguish it.
  A hidden request stays sendable; reporting never upgrades or closes it.
- **End** returns CONNECTED to REQUEST, retains history and clears the initiator so
  either participant may approach again. Decline likewise leaves no permanent
  graveyard; abuse/flood control belongs to ordinary rate-limiting, not a permanent
  state.
- **Read receipts** require CONNECTED plus mutual opt-in. REQUEST-stage messages
  stay `SENT` even if a server recorded a read. Local `FAILED`/`SENDING` outranks
  read state.

### Link gate, not the link boundary

`containsLink` is a **conservative pre-acceptance gate**, not the link boundary. It
rejects a scheme (`://`), compact `www.`, an email-shaped token, and a host with a
common ASCII/Unicode label plus a known suffix. It deliberately does not chase every
obfuscation. `example[.]com`, spaced `www . example . com` and unusual suffixes may
pass as *text*. The actual boundary is `linkify: false` on every REQUEST result plus
a renderer contract of plain text with no autolinking and no Markdown links. Do not
treat the scanner as the security boundary.

Cost is bounded by construction: the trailing-punctuation strip and the host check
are explicit single-pass character loops, not regexes, because `[)…]+$` backtracks
quadratically on a long punctuation run followed by an ordinary character (measured
6.8 s at the 100,000-unit bound before the rewrite). Tests cover dotted labels,
plain letter runs, punctuation runs, mixed punctuation, dot runs and bracket runs at
and near the bound, plus a 4×-input scaling assertion that separates linear (~4×)
from quadratic (~16×).

## Android SQLite local history (`sqliteSchema.ts`, `sqliteHistory.ts`)

- Pure pragmas/DDL/statement text, plus an adapter over an injected synchronous
  `SqliteDriver`. No driver import reaches the mobile bundle; the future Capacitor
  bridge supplies the driver.
- **Durability is verified, not assumed.** After issuing the pragmas the adapter
  reads back `journal_mode`, `synchronous` and `foreign_keys`, and rejects a
  non-WAL/in-memory connection, a non-FULL synchronous mode or disabled foreign
  keys before it can issue a persistence receipt. This is still an OS/filesystem
  promise, not measured power-loss proof.
- **Account/installation binding is atomic.** The identity keys and schema version
  are checked and established under one `BEGIN IMMEDIATE`, an existing incompatible
  binding is never overwritten, and every later operation re-checks the binding.
  A future schema version is rejected rather than silently downgraded.
- **Outgoing confirmation**: an authoritative TEXT echo of this account's own
  message commits the event/sequence identity and removes the outbox entry in the
  same transaction. QUEUED, SENDING and FAILED messages all confirm; a replayed echo
  is idempotent; a late failure cannot overwrite success.
- **Identity is immutable.** One event maps to one message, one mailbox entry maps
  to one event/message/sequence, and a stored message's conversation/participants/
  body cannot change (body is exempt only when an unsend already erased it).
  Conflicts reject before any receipt or ACK, and never move a conversation cursor.
- **Tombstones dominate**: an unsend clears the body, removes any pending outbox
  row, and a replayed or late-arriving message is stored body-less. An unsend that
  contradicts the stored author or conversation is rejected.
- **Personal deletion** is identity-keyed and may arrive before the content; the
  row is retained for the other participant's copy, and both `getMessage` and
  `listMessages` apply the same delete-for-me and clear-through visibility rules.
- **ACK only after commit**: `persistInboundAndAck` invokes the callback after the
  transaction commits (verified by an independent connection), and never after
  close. A mid-transaction failure rolls back and does not ACK.
- `claimOutbox` requires SQLite `RETURNING` (SQLite ≥ 3.35) and a bridge that
  returns DML rows; the selected bridge/version is not chosen yet. The driver must
  be file-backed and synchronous.

This module is not server authorization: the caller must supply server-validated
pair state, and the server must independently enforce the same rules. The existing
`20261024*_r3_chat_*` migrations do **not** yet enforce several of them; see
`CF-CHAT-POLICY-025-SERVER-GAPS.md` in the session evidence directory.

## Storage boundaries closed in the current source

The r2 review recorded four SQLite limits. All four are now fixed, with
regression coverage in `sqliteHistory.test.ts`:

1. **A future schema version is rejected before mutation.** The stored version is
   read from `messaging_meta` before the pragmas or any DDL run, and again under
   the binding transaction. A file labelled with an unknown version is never
   reshaped into a current database. (The test that claimed to cover this wrote
   legacy version `2`, which is accepted; it now writes an actual future version.)
2. **A tombstone binds the recipient.** Schema v4 adds `tombstones.recipient_id`
   and every new tombstone records conversation, author *and* recipient; an
   identity match requires all three. v1–v3 files are migrated additively
   (`alter table ... add column`), legacy rows keep a NULL recipient, and a later
   authoritative state change binds it (`bindTombstoneRecipient`).
3. **Delete-for-me cancels an unsent message.** `deleteForMe` erases the local
   body and, for a message the server has never accepted, deletes its outbox row,
   so it can never be delivered after the user deleted it. A send already claimed
   by a sender may still complete; the echo then re-erases the body.
4. **A mailbox replay cannot resurrect content.** `mailbox_seen` and the message
   row commit in one transaction, so a recorded envelope with no stored row means
   deliberate local deletion: the replay is acknowledged and applied to nothing.
   Neither the message nor the conversation shell is recreated. The web adapter
   enforces the same rule.

Server-authoritative erasure state (`STATE_SYNC`: `UNSEND`, `DELETE_FOR_ME`,
`CLEAR_FOR_ME`) is applied by **both** adapters. A state change is metadata, not
the message's TEXT event: it never stamps a synthetic server event identity on the
message, so a state change that arrives before or after the authoritative echo
cannot block it. Web coverage for all three kinds was added in
`indexedDbHistory.test.ts`; it exposed and fixed an identity check that rejected a
normal delete-for-me after a text echo.

## Portable history backup (SQLite)

`backup.ts` defines a transport-agnostic snapshot. It is **history, not a database
image**: only accepted messages (`server_event_id` and `server_sequence` both
present) travel, and `mailbox_seen`, the outbox and per-device read state are
excluded. A restore is not a send, not an acknowledgement and not metadata
application, so it never creates send work, mailbox receipts or state events and
never claims a state cursor.

```
{ format: "findback.chat.backup", version: 1, accountId, deviceId, exportedAt,
  snapshot: { conversations, messages, tombstones, deletedForMe, clears },
  digest }                                    // sha256 over canonical JSON, minus digest
```

**Integrity is not authenticity.** The digest is unkeyed SHA-256. It detects
corruption and accidental mixing of two files; it cannot detect forgery, because
anyone can recompute it. Every record is therefore validated on its own terms
(uuid, positive sequence, participant sanity, body bounds) exactly as if the digest
had passed on an attacker's file, and the account check is the only cross-account
guard. Drive authorization and encryption belong to the transport, not here.

**Normalisation.** The two adapters differ in two ways the snapshot must absorb:

- suppression is `NULL` in SQLite and `""` in IndexedDB, and `""` is never a valid
  body — so the snapshot uses `body: null` for "suppressed" and converts at the
  boundary;
- the web adapter keeps no message timestamp, so `createdAt` is nullable and
  normalises to the constant `0`, meaning "unknown, never observed". `0` is a
  constant rather than a wall-clock fallback precisely so the merge cannot become
  direction-dependent. Accepted messages are ordered by their unique
  `server_sequence` first, so `created_at` only breaks ties that cannot exist.

**Merge is commutative.** Every rule is min, max, union or "suppressed wins":
`lastSequence` and `updatedAt` take the max, `createdAt` the min, tombstones and
personal deletions union by message id, a clear takes the max boundary, and a
suppressed body always wins over a visible one. Merging A into B and B into A
therefore reach the same state; the test suite asserts that directly rather than
arguing it.

**Fail closed.** A contradiction is never resolved by picking a side: the same
message id with a different conversation, author, recipient, event or sequence; a
tombstone with a different conversation or author, or a different *non-null*
recipient; a snapshot claiming a conversation sequence another message already
uses; or a different body for the same accepted message. The whole import is one
transaction, so a failure leaves nothing behind. A local *unbound* legacy tombstone
(`recipient_id` NULL) may still be bound from the snapshot, the same way an inbound
state change binds it.

**A tombstone may only suppress the message it describes.** The backstop matches on
message id, so a tombstone is checked against the message before it is stored and
again when a message arrives for an existing tombstone: the conversation and the
author must agree, the recipient must agree when the tombstone is bound, and two
*known* unsend times must be equal. A tombstone that names a different author would
otherwise erase a message the user can still read. When the message carries no unsend
time, it adopts the tombstone's, so one unsend stays one event whichever of the two
arrives first. An *unbound* legacy tombstone (`recipient_id` NULL) is still accepted
and is bound from the recipient the message actually has, exactly as the inbound state
path does.

**The input is untrusted data, not a JavaScript value.** The record arrays must be
plain and dense: a sparse array, a hole compensated for by an extra property, a
`{length: 1}` object or a hostile accessor is rejected as `backup: invalid snapshot`
rather than allowed to fail later inside the adapter.

**Caller data is read exactly once.** `readSnapshot` copies every field into plain
records under one guard, and that copy is what the digest, the record checks, the merge
and the returned envelope all use. A stateful getter therefore cannot answer a valid
value to validation and a different one to the merge, and cannot throw outside the
documented error boundary. Two consequences are load-bearing:

- the adapter's `importSnapshot` normalises **before** the serial queue clones its
  arguments, because `structuredClone` invokes accessors — a guard placed after the
  clone is not a guard at all;
- that wrapper is `async`, so a rejected import is a rejected promise like every other
  method, not a synchronous throw.

Values are copied verbatim, never normalised, so the copy stays byte-identical to what
the caller sealed and the digest still means what it says. That equality holds for every
input this module accepts, because an **unknown key is rejected**: the copy keeps only
the known fields, so a sealed record with an extra field would otherwise hash differently
and be reported as `digest mismatch` when the real problem is an unknown field. Both the
envelope and every record type therefore have an exact own-key set.

"Own" is meant literally, and it is enforced at the level of property **descriptors**,
because every cheaper check is a question the caller's object answers about itself:

- `Object.keys` cannot see fields supplied by a prototype, so a record built with
  `Object.create(schema)` has no own keys at all;
- `hasOwnProperty` is answered by the object too, so a `Proxy` can report the schema names
  through `ownKeys`/`getOwnPropertyDescriptor` and still resolve ordinary reads through
  its target's prototype;
- ordinary property access (`row.body`) follows the prototype chain and invokes getters.

So no field is read by ordinary access. Each one is taken from
`Object.getOwnPropertyDescriptor(row, key)`, which must exist and must be a **data**
descriptor (`value`, not `get`/`set`). An inherited field has no own descriptor; an
accessor has one without a value. Both are `backup: invalid snapshot`, and an accessor is
rejected **without being invoked** — a serialized backup has no accessors, so there is no
reason to run caller code to discover that.

A Proxy can still lie about its own descriptors, but a lie is then indistinguishable from
a plain object that owns those values, which is a legal backup shape: the copy contains
the descriptor-declared value and never the inherited one, so no privilege is gained. The
rule is about ownership, not about a particular prototype — a `null`-prototype record that
owns every field is accepted, because that is what a defensive parser produces.

The same rule applies to the snapshot object itself and to every array: the five top-level
names are an exact own-key set, and an array must own every index with nothing but indices
and `length`, so a hole cannot be compensated for by an added property and an element is
never read by ordinary access either.

`length` is read from its descriptor as well. `value.length` is an ordinary read, and a
`get` trap can answer `0` while the target still holds rows — the copy would then be an
empty array and the supplied rows would vanish with no error at all, which matters most for
the adapter's direct `importSnapshot` (no envelope, no digest, so an empty import looks
like a successful one). The declared length must be a non-negative safe integer and must
agree with the reported index set, and every index below it must be an own data property.

`createBackup` follows the same rule in the outbound direction: it normalises the
adapter's export once and validates, digests and returns that same plain copy. An adapter
that supplies a field through an accessor is rejected like any other caller input, and the
returned snapshot is this module's own copy — a later mutation of the adapter's object
cannot change what was hashed.

**Anti-resurrection backstop.** After the merge, in the same transaction, the body
is forced to `NULL` for every message named by a tombstone, present in
`deleted_for_me`, carrying an `unsent_at`, or covered by a clear
(`server_sequence <= through_sequence`) — even when the snapshot supplied a body.
That is what makes an old backup safe to restore onto a newer device.

**Not implemented yet:** the IndexedDB adapter's `exportSnapshot`/`importSnapshot`
reject loudly rather than silently dropping history; Drive transport, encryption and
linked-device transfer are separate waves.

## Still open

The web adapter has no local pre-sync mutation methods (`recordUnsend`,
`deleteForMe`, `clearThrough`); it applies the authoritative state change after
`syncState`, while the SQLite adapter supports both local and authoritative
application. Offline web mutation is therefore not yet durable. Web backup parity is
also still open (above).

Also open: the Capacitor SQLite bridge and Android build/device proof, device
identity lifecycle/registry, transport validator and server stable-client-ID/
sequence protocol, server-side relationship/safety enforcement, 30-day mailbox/TTL,
FCM/realtime invalidation, retry scheduling/backoff, account deletion/purge, read
receipts/media rendering, linked-device recovery/backup, integration, UI/rendered
review, browser-disk/process-death and physical-device acceptance.
Current SQL does not yet provide this exact envelope/client-ID/sequence contract;
the adapter is not a direct mapping of existing RPC results.

Tests use real fake-indexeddb transactions (including abort after write success) and
a real `node:sqlite` file database. They prove logical persistence across
close/reopen and the SQL statements themselves, not browser disk durability, OS
power loss, the Capacitor bridge or native Android behaviour.

## Media adapter boundary (F2b-2)

SQLite v6 adds `media_attachments`; IndexedDB v4 adds `mediaAttachments` and
`mediaLifecycle`. SQLite v5's empty caption remains distinct from `NULL`
suppression. Text unsend tombstones remain in message history; their attachments
do not. Portable backups still exclude media bytes, and web backup support is
not supplied by this stage.

Both adapters accept an injected `MediaBytesPort`. For each account its backing
byte database must belong to exactly the same metadata database: installation
and backend. Handles of that same history may share it; different installations
or backends may not. Platform integration must select that isolated byte database
and close it only after `history.close()` drains. The platform owner supports
opt-in `media: { backendUrl }` composition (see below); the session/runtime does
not yet enable it. Transport, account-deletion integration and UI remain separate
F2b-3/F2b-4 work. These adapter methods alone are not shipped chat media.

Safety is ordered, not atomic across stores:

1. Hold an account-scoped origin-wide Web Lock, including compensation/cleanup.
2. Verify immutable metadata, SHA-256, MIME, dimensions and bounded platform
   decoding. Commit bytes before committing attachment/message/outbox metadata.
3. Only after metadata commit may a delivery ACK run. Callback **entry** is under
   the account lock after revalidating the live row, purge fence, visible parent,
   stored bytes and synchronous open state. Async callback **completion** is
   outside the lock/local queue, permitting reentrancy. Callbacks must start
   scope-bound work at entry and honor the owner's abort signal; already-entered
   remote work cannot be recalled. Failed ACKs retain protected `AWAITING_ACK`
   bytes unless another operation suppressed them. Text echo alone never makes
   an attachment ready. READY settlement never recreates a removed row.
4. Commit suppression or `EVICTED` before deleting bytes. Interrupted/failed
   cleanup can leave unavailable orphan bytes, never authorize their rendering.
   Open runs one bounded sweep of 100 aged orphans under the same lock; the
   15-minute crash grace period remains enforced by the byte store.
5. Media purge durably fences future admission, including other handles/reopen,
   before clearing bytes. Retry cleanup after a byte-store error. Ordinary close
   does not purge. Close invalidates immediately and drains admitted work before
   allowing the byte port to close.

SQLite compensation deletes newly written bytes only after a positively
acknowledged rollback. A COMMIT response may be lost after the commit succeeded;
unknown outcomes retain bytes and reject without ACK. Rejected enqueue therefore
does not prove absence of committed pending work: reconcile/retry stable IDs.
An unknown rollback outcome invalidates and closes the SQLite handle before it
can expose uncommitted reads or retain a reusable writer transaction. Reopen to
reconcile; already committed rows/bytes survive. If driver close itself fails,
the handle stays invalid and owner `close()` reports that failure, not success.
This recovery includes BEGIN: a rejected bridge reply may follow a successful
transaction start. Reuse requires acknowledged rollback; otherwise invalidate
and close, preserving the original failure without admitting bytes or ACK.

Web Locks are required for media; an unavailable API is not silently replaced
with an in-process queue. Node host tests use Node's LockManager; browser/WebView
cross-tab and power-loss acceptance remain separate. Outgoing admission and
upload selection require a cached CONNECTED projection with no own block. This
is offline eligibility only; remote authorization must recheck current policy.

Tests inject decoding for synthetic image headers, but retain actual hash and
dimension checks. They do not prove real decoder compatibility, device quota,
20 MiB latency or native power-loss durability.

The composition suite uses the actual `openMediaBytes` code on fake-indexeddb
with both adapters, including file-backed asynchronous node:sqlite handles.
It tests quota/accounting, cleanup failures, LRU, erasure and lifecycle ordering,
not real browser persistence. A Node 24 LockManager snapshot can still list a
cancelled waiter; cancellation tests assert rejection and close before the held
lock is released, then absence of late writes, rather than snapshot removal.

### F2b-3A — production storage ownership

`openPlatformMessagingHistory({ accountId, deviceId, media: { backendUrl } })`
selects the same metadata adapters and opens scoped IndexedDB bytes on both
platforms. Android's installation UUID still comes from the native plugin. No
arbitrary byte port or database-name override is admitted at this boundary.

`scopedMediaBytes.ts` copies and validates platform/account/installation/backend,
then compare-or-inserts a durable registry binding **before** opening bytes or
metadata. Registry writes require strict durability and resolve on transaction
completion, not request success. The key matches the actual metadata identity:
Android platform+account, web platform+account+installation. A different backend
(or different native installation) for the same metadata database refuses before
any sweep/purge. First registration of legacy text metadata cannot establish its
historical backend provenance; it binds the currently configured owner only.

Byte names encode the complete owner tuple, including normalized backend base
path. A different web installation, account or platform cannot sweep another's
bytes, even after the crash grace period. Every scoped byte method enforces the
captured account. Ports are frozen and checked by an internal WeakMap; casts,
copied properties and raw stores cannot satisfy runtime ownership validation.
Close is memoized and immediately refuses new admission. The platform closes
history first and bytes after admitted storage cleanup; failed native close
retains the native lease and surfaces failure rather than claiming release.
Ordinary close retains data and registry binding.

Host tests exercise actual byte storage (fake-indexeddb), web metadata and the
file-backed SQLite native seam, with platform decoding replaced only on Node.
They cover aged-byte isolation, backend conflicts, atomic registration races,
foreign-account rejection, strict durability, blocked-open late connection
cleanup, option mutation and close ordering. They do not establish browser/device
power-loss behavior or complete account deletion. Registry enumeration, durable
deletion fencing and full history purge remain F2b-3C, not `clearMedia()`.
