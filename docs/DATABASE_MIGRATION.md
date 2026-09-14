# Database

FindBack has exactly two persistence paths, and they never mix.

```text
Real application / deployment:
Node / Express API → @supabase/supabase-js → Supabase Data API → Supabase PostgreSQL

Automated tests + local demo:
Node / Express API → typed Store → SQLite (node:sqlite)

Schema changes:
supabase/migrations/*.sql → Supabase CLI → remote Supabase project
```

There is **no raw PostgreSQL runtime connection**: no `pg` driver, no
`DATABASE_URL`, no custom PostgreSQL migration runner. The direct connection
was removed once the Supabase Data API Store was complete.

## Runtime — Supabase Data API

The domain services talk to a typed `Store` seam (`db/store/types.ts`).
`getStore()` (`db/index.ts`) selects the implementation from `DB_PROVIDER`:

| `DB_PROVIDER` | Store | Use |
|---|---|---|
| `supabase` | `SupabaseStore` (Data API via `@supabase/supabase-js`) | real application + deployments |
| `sqlite` | `SqliteStore` (in-memory/file SQLite) | automated tests + local demo |

`SupabaseStore` uses the backend-only **secret key** (`SUPABASE_SECRET_KEY`,
service role). It bypasses RLS and must never reach the mobile app, any
`VITE_*` variable, API responses, logs, or build output. Backend-only aggregate
reads use the `SECURITY INVOKER` RPCs `findback_query_posts` and
`findback_report`, whose `EXECUTE` is granted only to `service_role`.

Configure the app through a single gitignored root `.env` (see `.env.example`):

```bash
DB_PROVIDER=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<service-role-key>
SUPABASE_PUBLISHABLE_KEY=<publishable-anon-key>
```

Deployments set the same variables through the platform environment.
`config.ts` resolves `<repo>/.env` relative to the module, so it loads no matter
the working directory, and process environment always wins.

## Tests — SQLite only

The API test suite always runs against in-memory SQLite (`:memory:`), seeded
with fictional demo data (`db/seed.ts`, `tests/setup.ts`). Provider selection is
pinned: `config.ts` forces `dbProvider = "sqlite"` whenever `NODE_ENV=test`, so
tests can never reach the live Supabase project even if `DB_PROVIDER` is set.

`npm run seed` and `npm run dev:api` with `DB_PROVIDER=sqlite` remain the local
demo path. `db/sqliteAdapter.ts` holds the local SQLite schema; keep it in sync
with `supabase/migrations/*.sql` when columns change.

## Schema changes (Supabase CLI)

Every schema change is a migration file applied to the remote project with the
Supabase CLI. Do not paste SQL into the Dashboard.

```bash
# 1. Create a new timestamped migration
npx supabase migration new <name>

# 2. Edit supabase/migrations/<timestamp>_<name>.sql

# 3. Review and apply
npx supabase db push --dry-run
npx supabase db push

# Inspect applied vs local
npx supabase migration list
```

Already-applied migration files are historical record: never edit them to change
schema. Send RLS/policy changes, new tables, and RPCs as new migrations.

## Auth migration progress (historical — see the cutover section below)

_This section records the earlier step-by-step preparation. Supabase Auth later
became the live production provider (see "Supabase Auth cutover" below), so
future-tense statements here are superseded._

`public.users.password_hash` is now **nullable** (migration
`20260912190128_auth_password_hash_nullable`). Supabase Auth will own password
storage, so a production profile row can be inserted without a password. The
column itself is kept for now because the local/SQLite auth provider still uses
it; dropping it is deferred until the Supabase Auth cutover is complete. User IDs
stay `text` (a Supabase Auth UUID is stored as its string form) and no
`auth.users` foreign key is added.

The internal API `AuthProvider` contract is also future-proofed: it can now
represent a registration with no session yet (pending email confirmation), a
session that carries optional `refreshToken`/`expiresIn`/`expiresAt`, an explicit
`refresh()` operation, and a verification result that may carry the first
session. `LocalAuthProvider` still returns the existing local JWT and the public
REST contract is unchanged; no Supabase Auth call or schema change is part of
this step.

`SupabaseAuthProvider` implements the core operations against Supabase Auth:
`register` calls `signUp` and writes the profile row with `password_hash = null`
(rolling back the Auth user through the admin API if the profile insert fails),
`login` resolves the identifier to an email and calls `signInWithPassword`,
`refresh` calls `refreshSession`, `validateAccessToken` uses `getClaims` (JWKS
verification for asymmetric signing keys), and `signOut` revokes only the current
session through the admin API. Supabase Auth uses the publishable key for user
operations and the secret key only for trusted admin operations, both
server-side.

Email signup verification is implemented too: `resend({ type: "signup", email })`
resends the confirmation, and `verifyOtp({ email, token, type: "email" })`
verifies the one-time code, sets `public.users.email_verified = 1`, and returns
the first session. The internal verification contract addresses a target
(`{ channel: "EMAIL", email? | userId? }` or `{ channel: "PHONE", userId }`) so a
pending signup can be verified before a user/session exists. Phone verification
remains unsupported (`501 "Phone verification is not available yet"`); no SMS
provider is wired.

## Supabase Auth cutover (production is live)

`getAuthProvider()` now selects by backend: `DB_PROVIDER=supabase` →
`SupabaseAuthProvider`, and `sqlite` (tests + local demo) → `LocalAuthProvider`.
`config.dbProvider` is pinned to `sqlite` under `NODE_ENV=test`, so tests always
use the local provider even if `DB_PROVIDER=supabase` is set; if Supabase is
selected without its configuration, provider construction throws instead of
silently falling back.

REST session contract:

- `POST /auth/register` returns a union: a **pending** account
  (`{ user, emailVerificationRequired: true, email }`, no token — Supabase
  Confirm-email is ON) or an immediate full session when confirmation is off.
- `POST /auth/login` returns `{ token, refreshToken?, expiresIn?, expiresAt?, user }`
  (local omits the refresh/expiry fields).
- `POST /auth/refresh` exchanges a refresh token; Supabase rotates it, so the
  client must replace the stored refresh token. The local provider reports the
  capability gap as `501`.
- `POST /auth/email-verification/send` and `/verify` are **public** (a pending
  signup has no access token). Send is generic (enumeration-resistant); verify
  returns the first session and is EMAIL-only.
- The old authenticated `/verification/:channel/*` routes stay for compatibility
  and still expose only `{ emailVerified, phoneVerified }`.

Access tokens are validated with `getClaims` everywhere (REST middleware, GraphQL
context, Socket.IO handshake). The mobile app now authenticates directly with
Supabase Auth using the publishable key (see "Direct mobile Supabase Auth"
below), stores the access + rotating refresh token, refreshes once on `401`
(single-flight) and retries, and sends the current Supabase access token to the
retained Node API as a `Bearer` token.

Hosted readiness (read-only checks): email provider enabled, Confirm email
required, custom SMTP configured, Confirm-signup template contains `{{ .Token }}`.
The project's `mailer_otp_length` is **8**, so code validation accepts 6–10 digits
(Supabase's configurable range) rather than 6. A live end-to-end pass succeeded
(register → emailed code → `verifyOtp` session → `/auth/me` → GraphQL → Socket.IO
→ refresh → logout → refresh rejected), and the test user was fully removed.
Custom SMTP is configured and live email OTP verification passed.

## Direct mobile Supabase Auth (transition)

Block 10B moved **Auth** into the app, Block 10C moved the **register-time
username availability check**, and Block 10D moved the **post reads** (feed /
single post / My Posts). Mobile calls Supabase directly with
`@supabase/supabase-js` and the **publishable key** (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`). Those values are public and safe to bundle; the
secret/service-role key is never in the app.

This is a dual-run transition, not full Node independence.

Direct Supabase today:

- signup / login / logout / session restore / emailed signup OTP
- own profile read (`public.users`: safe public columns + Auth session identity)
- username availability (`public.users`, anon, `username` column only)
- feed / single post / My Posts reads (`findback_query_posts_client`, authenticated)
- create post / change post status (`findback_create_post_client`,
  `findback_change_post_status_client`, authenticated)
- comments list/add/delete-own (`findback_list_comments_client`,
  `findback_add_comment_client`, `findback_delete_comment_client`)
- like/dislike/remove + rating + caller hydration (`findback_react_client`,
  `findback_rate_client`, `findback_post_social_state_client`)

Temporarily on Node (still Bearer-validated with the Supabase access token):

- post edit/delete from the legacy API (no mobile UI yet)
- uploads / Storage, Socket.IO realtime, reporting, AI Help
- other legacy endpoints (including the still-present `GET /users/check-username`)

Migrations:

- `20260914120000_direct_auth_profiles.sql` — `auth.users` → `public.users`
  profile trigger built from validated metadata (never from user-supplied
  `email_verified`/`phone_verified`); `email_verified` sync trigger on auth
  updates; `users` RLS self-only SELECT plus column grants.
- `20260914130000_direct_auth_profiles_legacy_tolerant.sql` — the profile trigger
  skips when username/phone metadata is absent, so the legacy Node registration
  path still works.
- `20260914140000_auth_profile_delete_cascade.sql` — deleting an auth user
  deletes the profile, cascading to the user's posts/comments/reactions/ratings.
- `20260914150000_tighten_function_security.sql` — pins `findback_uid()`'s
  `search_path`.
- `20260914160000_drop_username_login_resolver.sql` — drops
  `public.findback_login_email(text)`. Login is **email-only**: a username is the
  unique public profile identity, not an authentication identifier, so the
  anonymous `SECURITY DEFINER` resolver (an account-enumeration surface) is gone.
- `20260914170000_username_availability_lookup.sql` — grants `anon` SELECT on the
  `username` column only, plus a SELECT-only RLS policy, so the Register
  availability check can run before authentication with no `SECURITY DEFINER`
  function. `anon` still has no INSERT/UPDATE/DELETE and cannot read email,
  phone, `password_hash`, or verification state.
- `20260914180000_client_post_reads.sql` — the read boundary for Block 10D.
  `authenticated` keeps SELECT on the **safe public** `users` columns only
  (`id, username, email_verified, phone_verified, avatar_url, created_at`) and may
  read them for every user; `email`, `phone`, and `updated_at` are revoked. The
  self-only policy is replaced by `users_select_public_authenticated`. Feed tables
  (`item_posts`, `attachments`) and aggregate-only columns
  (`comments(id,post_id)`, `reactions(id,post_id,type)`, `ratings(id,post_id,score)`)
  are granted SELECT to `authenticated` with SELECT-only policies — no writes.
  `verification_challenges`/`uploads` keep zero client access. The client-safe
  RPC `findback_query_posts_client` (SECURITY INVOKER, EXECUTE `authenticated`
  only) returns public author fields without email/phone, supports exact post
  lookup and keyset pagination, and clamps the page size to 20 in SQL. The
  original `findback_query_posts` (which still returns `author_email`/
  `author_phone`) stays `service_role`-only.
- `20260914190000_post_mutations.sql` — direct authenticated post writes.
  `findback_create_post_client` / `findback_update_post_client` /
  `findback_change_post_status_client` / `findback_delete_post_client`
  (SECURITY INVOKER, EXECUTE `authenticated` only) always use `auth.uid()` as the
  actor, never a caller-supplied owner; create starts `OPEN` and atomically binds
  a staging upload that must belong to the caller. Grants: `authenticated` may
  INSERT/UPDATE/`DELETE` `item_posts`, INSERT `attachments`, and SELECT its own
  `uploads`, each behind owner-scoped RLS (`UPDATE` has `USING` + `WITH CHECK`).
- `20260914191000_fix_rls_initplan.sql` — wraps `auth.uid()` in `(select
  auth.uid())` inside those policies so the planner evaluates it once
  (`auth_rls_initplan` advisor cleared).
- `20260914200000_social_client_rpcs.sql` — direct social reads/writes for
  Block 10F, all SECURITY INVOKER and EXECUTE `authenticated` only. Comments are
  public content: `findback_list_comments_client` / `findback_add_comment_client`
  / `findback_delete_comment_client` return a `PublicProfile` author and never
  email/phone; insert/delete are owner-scoped (a post owner may also delete a
  comment on their own post, matching the Node moderation rule). Reactions and
  ratings stay **aggregate-only** to clients — `authenticated` never receives
  `user_id`, so `findback_react_client` / `findback_rate_client` scope writes by
  RLS policy and locate the caller's own row by a deterministic id
  (`md5('<kind>|<post_id>|<uid>')`); `findback_post_social_state_client` hydrates
  the caller's own reaction/rating from that same id without reading `user_id`.

`public.users.id` stays `text` storing the Supabase Auth UUID string. Verified
live: profile creation; `anon` cannot read `users` email/phone/verification and
cannot write; `anon` reads only the `username` column; `authenticated` reads the
safe public columns for every user but cannot read any user's email/phone/
`password_hash`; email + password sign-in works; signOut works; the resolver is
gone; and a Supabase access token authenticates the legacy Node `/auth/me` and
`/posts`.

Block 10D was verified live against the hosted project with two temporary
accounts (created by exact id, then deleted; the pre-existing account was
untouched). Confirmed: `anon` cannot read posts or execute the client RPC;
`authenticated` reads the feed and a single post with **no** `author_email`/
`author_phone` in the payload (raw RPC response and rendered UI); cross-user
reads are allowed; safe profile columns are readable for all users while
`email`/`phone`/`password_hash` return `42501`; comment bodies and reaction/rating
user ids are not readable; `authenticated` cannot insert posts (writes stay on
Node); the private `findback_query_posts` still returns email/phone to
`service_role` only. The mobile UI rendered the feed, search, post detail (with
Node-served comments) and My Posts, and Profile still showed the signed-in user's
own email (Auth session) and phone (signup metadata).

Block 10F was verified live against the hosted project with two temporary
accounts (created by exact id, then deleted; the pre-existing account was
untouched). Anon is denied every social RPC; comments carry the real
`auth.uid()` actor and a public-only author; a comment author and the post owner
can delete, another user cannot; like → dislike → remove keeps exactly one row
per user; ratings upsert by caller and the live average/count are returned;
`myReaction`/`myRating` are correct after reload; and `reactions.user_id` /
`ratings.user_id` are not readable (`42501`) while the feed still counts them.
The mobile UI added a comment, reacted, rated, reloaded (selection hydrated
correctly), toggled the reaction off, deleted the comment, and the temp rows
were removed afterwards. Advisors return to the prior baseline (no
`SECURITY DEFINER` findings).

The availability check mirrors `ux_users_username_lower` exactly: it is
case-insensitive and treats `_` literally (LIKE metacharacters are escaped, so
there is no wildcard false-positive). The database unique index remains the final
authority — a signup race still surfaces as a clean duplicate-account error.

A live end-to-end acceptance ran through the mobile UI: a fresh signup was
submitted, Supabase delivered the real confirmation code by email (Brevo SMTP),
the code verified and opened the first session, the profile row was provisioned
with the right username, the session survived a reload, sign-out worked, and a
subsequent email + password sign-in succeeded; the temporary account was then
deleted.

Remaining advisor: Auth "leaked password protection" stays disabled (a Supabase
project setting, unchanged in this block).

## Supabase Storage (listing images)

Production uploads go only through the Node API:

`POST /uploads` (Multer) → image normalization (`sharp`) → `StorageProvider` →
Supabase Storage bucket `findback-images` → public object URL → `uploads` row.
The mobile app keeps calling the same `/uploads` endpoint and never talks to
Supabase Storage directly; Storage stays backend-only (the app's Supabase SDK
client is used only for Auth).

- Bucket `findback-images` is **public** (reads use plain public URLs, no signed
  URLs), `file_size_limit` 8 MB (hard safety ceiling) and `allowed_mime_types`
  `image/png`, `image/jpeg`, `image/webp`, `image/gif`. It is created/updated by
  a migration through `storage.buckets`, not the dashboard.
- Mutations are backend-only: the Node API writes with the secret key. No
  anon/authenticated Storage policies are added.
- Provider selection mirrors auth: `config.dbProvider` — `supabase` →
  `SupabaseStorageProvider`, `sqlite`/tests → `LocalStorageProvider`. Tests can
  never reach live Storage, and Supabase selection without configuration throws
  instead of falling back to disk.
- Object keys are opaque `<userId>/<uploadId>`; the client filename is metadata
  only and no client-supplied path is trusted.
- Normalization (`sharp`): EXIF orientation applied, longest edge capped at
  1920 px (never enlarged), re-encoded at web quality; GIFs pass through
  unchanged so animation is preserved. The stored `mime_type`/`file_size` always
  describe the final bytes while the API's 8 MB limit remains the incoming
  ceiling.
- Rollback: if the object write succeeds but the `uploads` insert fails, the
  just-written object is removed; a failed object write creates no row.
- Local mode mounts `/uploads` static serving only when `DB_PROVIDER=sqlite`, so
  it cannot shadow Supabase public URLs in production.

## Row Level Security

RLS is enabled on all eight public tables. The Data API Store connects with the
service role and bypasses RLS; the publishable/anon key cannot read or write
those tables (and cannot execute the backend RPCs). The Block 10B
`public.users` self-only SELECT policy is the first auth-scoped policy; broader
auth-scoped policies remain a later phase. `FORCE ROW LEVEL SECURITY` is
intentionally not used — it would also block the owner.

## Files

- `services/api/src/db/store/types.ts` — typed `Store` contract.
- `services/api/src/db/store/supabaseStore.ts` — production implementation (Data API + RPCs).
- `services/api/src/db/store/sqliteStore.ts` — test/local implementation.
- `services/api/src/db/sqliteAdapter.ts` — SQLite `DbAdapter` + local schema.
- `services/api/src/db/index.ts` — `getStore()` selection, `getAdapter()`, test helpers.
- `services/api/src/storage/*` — `StorageProvider` seam, local + Supabase adapters, selector, `sharp` normalizer.
- `services/api/src/domain/storageService.ts` — `recordUpload` (normalize → persist → record → rollback).
- `supabase/migrations/*.sql` — schema, RLS hardening, RPCs, and the `findback-images` bucket.
