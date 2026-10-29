# Private person-to-person messaging

This is the existing Chat R4 implementation, separate from AI assistant chat.
It includes the consumer inbox/thread/privacy screens, account-owned runtime,
durable web/Android history, private still-image transport and server-authorized
relationship/receipt/erasure operations. This describes source contracts, **not
full hosted, browser or physical-device acceptance**. It is not end-to-end encrypted.

## Owners and boundaries

| Area | Canonical owner |
|---|---|
| Consumer UI | `screens/Messaging.tsx`, `screens/MessagingPrivacy.tsx`, shared photo viewer |
| Account lifetime, refresh and authority invalidation | `runtime.ts`, `useMessaging.ts`, existing `AuthProvider` |
| Participant-scoped transport and durable delivery | `session.ts`, `supabaseSession.ts` |
| Local history contract | `history.ts`, `conversationIndex.ts`, `stateChanges.ts` |
| Platform selection | `platformHistory.ts` |
| Web storage | `indexedDbHistory.ts`; `indexedDbBackup.ts` merges portable metadata |
| Android storage | `androidSqliteDriver.ts`, native `FindbackMessagingSqlite`, `sqliteHistory.ts`, `sqliteSchema.ts` |
| Image preparation and transfer | `preparePhoto.ts`, `mediaTransport.ts`, `mediaContent.ts` |
| Byte storage and deletion ledger | `mediaBytes.ts`, `scopedMediaBytes.ts` |
| Portable history | `backup.ts`, both history adapters |

`policy.ts` is a pure policy model, not server authorization. Authorized RPCs and
Edge Functions independently enforce participants, device ownership and current
relationship policy. Push/realtime payloads are wake hints, never message,
relationship or receipt truth. Local history remains readable offline without
starting a new auth owner or inventing current online permission.

## Relationship, requests and receipts

- REQUEST and CONNECTED are relationship modes. Block is a separate private flag;
  no counterpart block/decline/hide decision is exposed as an oracle.
- A requester may send multiple text-only messages. Only the first approach in a
  request session is eligible for a quiet nudge. The recipient accepts before
  replying. End returns to REQUEST without deleting history.
- Requests have no media, active links or public read receipts. The conservative
  link scanner is an admission gate, not the boundary: the request renderer is
  plain text without autolinking/Markdown links even for obfuscated addresses.
- Read receipts require current CONNECTED authority and mutual opt-in. Observation
  uses actual visible thread progress; local read state does not imply permission
  to publish a receipt. Offline, newer wakes and relationship/preference changes
  invalidate cached receipt authority, including responses still in flight.
- New sends capture the observed opaque relationship epoch. Automatic retry may
  not rebind old intent. Explicit failed-message Retry keeps the stable message ID
  and obtains the current boundary; unknown legacy classification stays review-only.

## Durable history, outbox and ACK

`openPlatformMessagingHistory` selects explicit IndexedDB on web and the native
SQLite bridge on Android. Android never silently falls back to web or memory;
unsupported platforms fail visibly. The canonical session owner supplies the
account and random installation identity and closes on sign-out/switch.

Outgoing admission commits immutable message fields and an outbox row together.
A persisted 60-second SENDING lease fences concurrent attempts. Late failures
cannot overwrite a newer lease or success. HTTP SEND success does not mark sent:
only the participant-authorized durable mailbox echo settles the outbox.

Inbound persistence commits the message, event and mailbox identity before ACK.
One event identifies one message; each conversation sequence has one owner.
Duplicate/lost-ACK replay is idempotent, and out-of-order records sort by server
sequence rather than invented timestamps. A failed write/abort/close never
authorizes ACK. Async network ACK completion does not hold the storage lock.

IndexedDB writes require reported `durability === "strict"` and resolve only on
transaction completion. SQLite verifies file-backed WAL, FULL synchronous mode,
foreign keys and the account/installation binding. Unknown bridge transaction
outcomes reject and invalidate rather than claiming rollback or deleting possibly
committed bytes. These checks are **not measured power-loss/disk-flush proof**.

Authoritative UNSEND, DELETE_FOR_ME and CLEAR_FOR_ME metadata can arrive before
content. Matching suppression survives restore and later mailbox replay. Erasure
metadata is not a TEXT echo: it never fabricates a message event or state cursor.
Personal deletion/clear hide only this account's copy; unsend leaves a bodyless
placeholder. Web erase actions use the server's state path, not an invented
offline pre-sync mutation protocol.

## Private still images

The runtime uses the canonical preparation pipeline, owned byte store and
`chat-media` transport. Media is CONNECTED-only; text and image-only captions
retain explicit TEXT/MEDIA classification. Missing attachment metadata never
proves a legacy message was TEXT.

Bytes are verified (digest, MIME, dimensions and platform decoding) and persisted
before attachment metadata and ACK. Upload requires the accepted parent echo.
Successful POST leaves AWAITING_ACK, not READY; lost responses and download-again
use the same retained identity and durable ACK path. Refresh/recovery work is
bounded and does not replace the existing wake machinery.

Each byte database belongs to one platform/account/installation/backend metadata
owner. Registry bindings are committed before admission; conflicting provenance
fails closed. Account-scoped Web Locks serialize admission/cleanup across handles.
Suppression or eviction commits before bytes are deleted. Failed cleanup leaves
unavailable orphan bytes, not renderable attachments; bounded aged-orphan sweeping
can recover them. Backups contain history/classification, **not attachment bytes
or private download metadata**.

## Portable local history

Both SQLite and IndexedDB implement `exportSnapshot`/`importSnapshot` using the
same `backup.ts` envelope. Version 2 carries explicit classification; version 1
is verified before legacy unknown classification is normalized. IndexedDB schema
v6 retains portable metadata in existing stores and refuses older v5 code that
would not honor imported suppression.

```text
{ format: "findback.chat.backup", version: 2, accountId, deviceId, exportedAt,
  snapshot: { conversations, messages, tombstones, deletedForMe, clears }, digest }
```

- Only accepted messages travel. No outbox, mailbox receipts, per-device read
  progress or state cursor travels. Restore creates no sends or acknowledgements.
  It may settle an identical local pending send already accepted by the server.
- `body: null` is suppression; `body: ""` is a legitimate image-only caption.
  Unknown message timestamps normalize to 0, never the import wall clock.
- Each import is one transaction. Immutable identity/event/sequence/participant/
  classification contradictions abort it. Known unsend times must agree. Null
  recipients/conversations in legacy suppression bind only to matching identity.
- Suppression wins in either merge order, including tombstone/deletion/clear before
  original content. Imported null-body suppression also blocks later media
  readmission. Byte cleanup occurs only after committed metadata suppression.
- Snapshot-only conversation metadata retains display timestamps/sequences but
  invents no participant, relationship projection or live permission.
- Inputs are untrusted: exact own data fields and dense arrays are copied and
  validated against the database account **before** the serial queue can clone
  them. Accessors are rejected without invocation. Later caller mutation cannot
  change the admitted import.
- The unkeyed SHA-256 digest detects corruption, **not forgery, authorization or
  encryption**. Every record is still validated independently.

There is currently no consumer backup/export control, Google Drive transport,
automatic cloud backup, encrypted backup or linked-device transfer in this path.
The portable engine is not a promise that those product features exist.

## Account lifecycle

Ordinary logout/close invalidates handles and drains work but retains history.
Confirmed account deletion instead uses the existing auth cleanup owner and
`purgeMessagingAccount(capturedAccountId)`. A switch from A to B does not redirect
A's cleanup to B or sign B out.

The strict durable ownership registry retains a permanent deletion fence plus
independently revisioned pending messaging/auth work. Purge removes local rows,
projections, outbox, receipts, erasure/backup-source data and captured-account
bytes; all required resources must close before pending work is acknowledged.
Failed/incomplete cleanup remains retryable, and dismissing UI never clears it.
Legacy database inventory supplements registered scopes; absent/corrupt inventory
cannot count as empty success.

This is logical cleanup of current-origin/app-private stores, not forensic
SQLite/WAL erasure, external backup deletion or control of another origin/old
executable. Same-origin code/XSS is outside IndexedDB's isolation boundary.

## Verification limits

Host tests use actual fake-indexeddb transactions and file-backed `node:sqlite`,
including abort-after-write, close/reopen, cross-adapter backup, suppression and
account fencing. Synthetic media fixtures replace platform decoding on Node.
They do not establish real browser storage/codec compatibility, native process
death, physical-device/TalkBack behavior, authenticated multi-device delivery,
killed-app FCM or hosted source parity. Those require their own acceptance evidence;
a passing host suite or configured web build is not a substitute.
