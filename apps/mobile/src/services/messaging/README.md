# Human messaging local persistence

This is a **text-only, non-UI storage foundation**, independent of AI chat. It is
not full chat delivery or release acceptance. No production caller is wired yet.

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

## Deliberately open

Tombstones/delete-for-me/clear/authoritative-unsend are **not applied yet**. Their
stable message/event ID and sequence seam is reserved; unsupported events reject
without ACK rather than being dropped. Tombstone dominance, actual body removal,
cross-device personal deletion and backup non-resurrection must be implemented
and tested before shipping private chat. This text-only adapter does not claim
backup safety. Extend/migrate the IndexedDB schema rather than replacing history.

Also open: Android SQLite, device identity lifecycle/registry, transport validator
and server stable-client-ID/sequence protocol, relationship/safety enforcement,
30-day mailbox/TTL, FCM/realtime invalidation, retry scheduling/backoff, account
deletion/purge, read receipts/media, linked-device recovery/backup, integration,
UI/rendered review, browser-disk/process-death and physical-device acceptance.
Current SQL does not yet provide this exact envelope/client-ID/sequence contract;
the adapter is not a direct mapping of existing RPC results.

Tests use real fake-indexeddb transactions (including abort after write success),
not a faked repository. They prove logical persistence across close/reopen in the
test factory, not browser disk durability, OS power loss or native SQLite.
