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

## Deliberately open

The **web** adapter still does not apply tombstones/delete-for-me/clear/unsend; only
the SQLite adapter does. Tombstone dominance, cross-device personal deletion and
backup non-resurrection must be integrated on both before shipping private chat.
This text-only foundation does not claim backup safety.

Known SQLite limits, recorded from the r2 review and **not** fixed here. They must
be closed before the schema ships or the Capacitor bridge is chosen, because the
schema is unreleased and a version bump is still free:

1. A file labelled with a **future schema version is mutated before it is rejected**
   (the pragmas run and missing v1 tables are recreated, then the version check
   throws). Move the version read ahead of DDL, or refuse to touch an unrecognised
   file at all.
2. A tombstone binds conversation and author but **not recipient**, so a
   wrong-recipient tombstone can poison a message id.
3. `deleteForMe` on a pending send hides it while its outbox entry stays claimable;
   the §9 personal-delete semantics and §10 unsend semantics need an explicit
   decision on cancellation.
4. A mailbox replay after a raw conversation delete can resurrect one message.

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
