# Architecture

FindBack is a monorepo: one React/Capacitor client, a shared validation package,
and one Supabase backend (Postgres, row-level security, Edge Functions, storage).
The course-era Node/Express/GraphQL API and its reference container were retired
after source/workflow non-use proof. Git retains their history, not an active
second backend or demo-auth path.

```
apps/mobile/          React + Capacitor client (Android primary, web build for links/review)
apps/share-preview/   Read-only same-domain Azure HTTP share renderer
packages/shared/      Shared schemas, validation and constants
supabase/migrations/  Ordered SQL migrations (immutable once applied)
supabase/functions/   Deno Edge Functions (AI help, chat media, push, cleanup, trust)
docs/                 Product, architecture, history and acceptance documentation
scripts/              Build, verification and release tooling
```

## Client

- React + TypeScript, Vite, React Router, React Aria Components, Tailwind.
- Shared adaptive shell/overlay/composer/identity owners and one MediaViewer;
  see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) for component and route ownership.
- Capacitor wraps the same web build for Android; native plugins cover camera,
  geolocation, push, share, app launcher and browser.
- Local state and durable data live in IndexedDB on web and SQLite on Android. The
  chat store, outbox and restore paths are shared code so both targets behave the
  same way.
- On-device Needle/USE retain Smart Search, structured text tools and stage-two
  matching. No retired local-generative/photo-analysis runtime is reintroduced.
  Optional cloud AI Chat is a separate secondary surface using the user's own
  provider key, not a FindBack server relay.
- Startup waits for the one-time data epoch before importing auth, AI, messaging
  or other persisted owners. Native cleanup and the web marker commit last;
  failure stops startup rather than restoring deleted-account history.

## Public share renderer

- Existing `findbackapp.social` Azure Static Web Apps hosting serves a small
  dependency-free HTTP renderer at `/api/share/:id`. Legacy `/r/:id` links remain.
- HTML/social metadata and SPA JSON use one minimal public SQL projection, not
  full authenticated reports. No free-form contact/location text or photos are
  copied; revocation, moderation and deletion are enforced on fresh requests.
- Publishable configuration only, no visitor credential forwarding, no-store,
  fixed upstream RPC, bounded response/deadline and fail-closed metadata. This is
  not a replacement product API. Deployment/live acceptance is tracked separately.

## Backend (Supabase)

- Postgres with row-level security on every public table; privileged operations go
  through `SECURITY DEFINER` functions with pinned `search_path` and explicit grants.
- Edge Functions are the server-side boundary for AI help, chat media, push
  dispatch, cleanup jobs, trust maintenance and account deletion. They authenticate
  the caller and re-check authorization on every privileged action.
- Applied migrations are immutable. Changes are additive, timestamped and verified
  against the hosted migration head before and after deployment.
- Storage buckets are private; media access is signed and scoped to the caller.

## Data flow: a report

1. The client retains a local draft and stages prepared photos before publication.
2. An account-bound RPC delegates to the canonical create owner; the server checks
   ownership, validation, visibility and staged-media references. Leaving before
   dispatch cancels publication; an uncertain dispatched result retains uploads
   and prevents blind retry.
3. The invoker/RLS v2 candidate RPC scores category/text/date/location before its
   bounded80 pool. Existing local Needle/USE/visual ranking remains stage two;
   web retains a non-native baseline. Local embeddings are not sent to this RPC.
4. Recovery is confirmed by the current owner of the report; the rating is created
   only from a real recovery.

## Data flow: private chat

1. A message request is text-only and separate from an accepted connection.
2. After acceptance, still images are allowed through private storage.
3. Each device keeps durable history; the server mailbox is temporary delivery.
4. Delivery is acknowledged only after local persistence, so a lost ACK does not
   duplicate or drop messages.
5. Push notifications wake the app; they do not carry message text.
6. Report-linked subjects resolve authorization live and revoke loaded previews on
   local safety/report invalidation. Static location is explicit and connected-only,
   not tracking. Per-user mute syncs; Archive reuses personal hide semantics.
7. A separate versioned exact-payload identity makes accepted sends replayable
   without retaining their erased body, report reference or coordinates. The
   historical body digest still authenticates bounded moderation evidence from
   durable recipient history. Unreconstructable already-erased legacy identities
   fail closed; reconstructable legacy payloads are backfilled before erasure.

M7-P people search, mute, context/location and forward integrity repair migrations
were observed hosted at the Product Fit Reset baseline. Product Fit Reset adds
matching-v2, sanitized public preview and explicit privileged role acceptance.
Hosted application/readback and publication state are recorded in the
[current checkpoint](releases/PRODUCT_FIT_RESET_2026-11-02.md).
Local render/source acceptance does not establish native, real-account or live
service acceptance. No Edge Function deployment accompanies a source commit.

## Trust boundary

- Roles (moderator/admin) are checked server-side for every staff action; the UI
  merely hides what the caller cannot do.
- A confirmed email offer is not an assigned role. Normal account setup precedes
  explicit acceptance under the server's role/deletion lock; signup attachment
  triggers are removed. Replaced/revoked/stale offers cannot confer privilege.
- Moderation, appeals and feedback write durable audit records.
- Account deletion removes the account, reports and photos, and deliberately retains
  limited safety records (reported-content evidence, appeal/moderation/audit) for a
  bounded period.

## Where to look next

- Setup and checks: [DEVELOPMENT.md](DEVELOPMENT.md)
- Legacy retirement boundary: [LEGACY_API_RETIREMENT.md](LEGACY_API_RETIREMENT.md)
- Version history: [history/VERSION_HISTORY.md](history/VERSION_HISTORY.md)
- Freeze record: [releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md](releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md)
- Data model: [erd/](erd/)
