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

## Auth migration progress

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

`SupabaseAuthProvider` now implements the core operations against Supabase Auth:
`register` calls `signUp` and writes the profile row with `password_hash = null`
(rolling back the Auth user through the admin API if the profile insert fails),
`login` resolves the identifier to an email and calls `signInWithPassword`,
`refresh` calls `refreshSession`, `validateAccessToken` uses `getClaims` (JWKS
verification for asymmetric signing keys), and `signOut` revokes only the current
session through the admin API. Email/phone verification stays deliberately
unimplemented (a later block). The provider is **not selected** by
`getAuthProvider()`; the running application still uses `LocalAuthProvider`.
Supabase Auth uses the publishable key for user operations and the secret key
only for trusted admin operations, both server-side.

## Row Level Security

RLS is enabled on all eight public tables. The Data API Store connects with the
service role and bypasses RLS; the publishable/anon key cannot read or write
those tables (and cannot execute the backend RPCs). Auth-scoped policies are a
later phase. `FORCE ROW LEVEL SECURITY` is intentionally not used — it would
also block the owner.

## Files

- `services/api/src/db/store/types.ts` — typed `Store` contract.
- `services/api/src/db/store/supabaseStore.ts` — production implementation (Data API + RPCs).
- `services/api/src/db/store/sqliteStore.ts` — test/local implementation.
- `services/api/src/db/sqliteAdapter.ts` — SQLite `DbAdapter` + local schema.
- `services/api/src/db/index.ts` — `getStore()` selection, `getAdapter()`, test helpers.
- `supabase/migrations/*.sql` — schema, RLS hardening, and RPCs.
