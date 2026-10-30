# Architecture

FindBack is a monorepo: one React/Capacitor client, one Node API, a shared package,
and a Supabase backend (Postgres, row-level security, Edge Functions, storage).

```
apps/mobile/          React + Capacitor client (Android primary, web build for links/review)
services/api/         Node/Express + GraphQL API (local and non-Supabase deployments)
packages/shared/      Shared schemas, validation and constants
supabase/migrations/  121 applied SQL migrations (immutable once applied)
supabase/functions/   Deno Edge Functions (AI help, chat media, push, cleanup, trust)
docs/                 Product, architecture, history and acceptance documentation
scripts/              Build, verification and release tooling
```

## Client

- React + TypeScript, Vite, React Router, React Aria Components, Tailwind.
- Capacitor wraps the same web build for Android; native plugins cover camera,
  geolocation, push, share, app launcher and browser.
- Local state and durable data live in IndexedDB on web and SQLite on Android. The
  chat store, outbox and restore paths are shared code so both targets behave the
  same way.
- AI runs on-device where claimed (Smart Search, match suggestions, report-photo
  analysis via LiteRT/MediaPipe). Cloud AI Chat is a separate surface that uses the
  user's own provider key and is not relayed by a FindBack server.

## API

- `services/api` exposes REST and GraphQL over the same domain model, with JWT auth,
  request validation (Zod) and rate/abuse middleware.
- It is the deployment path for environments that do not use Supabase directly; the
  app's production path is Supabase + Edge Functions.

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

1. The client writes the report locally first, then syncs it.
2. The server validates ownership, visibility and media references.
3. Matching suggestions are computed from report attributes; on-device suggestions
   never leave the phone.
4. Recovery is confirmed by the current owner of the report; the rating is created
   only from a real recovery.

## Data flow: private chat

1. A message request is text-only and separate from an accepted connection.
2. After acceptance, still images are allowed through private storage.
3. Each device keeps durable history; the server mailbox is temporary delivery.
4. Delivery is acknowledged only after local persistence, so a lost ACK does not
   duplicate or drop messages.
5. Push notifications wake the app; they do not carry message text.

## Trust boundary

- Roles (moderator/admin) are checked server-side for every staff action; the UI
  merely hides what the caller cannot do.
- Moderation, appeals and feedback write durable audit records.
- Account deletion removes the account, reports and photos, and deliberately retains
  limited safety records (reported-content evidence, appeal/moderation/audit) for a
  bounded period.

## Where to look next

- Setup and checks: [DEVELOPMENT.md](DEVELOPMENT.md)
- Version history: [history/VERSION_HISTORY.md](history/VERSION_HISTORY.md)
- Freeze record: [releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md](releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md)
- Data model: [erd/](erd/)
