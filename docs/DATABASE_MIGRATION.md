# Database migration — SQLite → PostgreSQL/Supabase

Scope of this pass: **database only**. Auth, Storage, Realtime, AI, ML, Maps,
GraphQL, REST routes and Android packaging are untouched and still use their
existing demo providers.

## What changed

| Area | Before | After |
|---|---|---|
| Schema | SQLite-only, inline in `db/db.ts` | SQLite schema in `db/sqliteAdapter.ts`; PostgreSQL DDL in `supabase/migrations/20260912000000_init.sql` |
| Data access | Sync helpers `run/get/all` from `db/db.ts` | Async `DbAdapter` contract (`db/types.ts`) with two implementations |
| Providers | SQLite hard-coded | `DB_PROVIDER=sqlite` (default) or `DB_PROVIDER=postgres` |
| PostgreSQL client | — | `PostgresAdapter` on `pg` (`db/postgresAdapter.ts`) |
| Migrations | — | `npm run db:migrate` applies `supabase/migrations/*.sql` (`db/migrate.ts`) |
| Env | — | `DB_PROVIDER`, `DATABASE_URL`; documented in `.env.example` |

Key files:

- `services/api/src/db/types.ts` — `DbAdapter` interface + `Row`/`SqlValue`.
- `services/api/src/db/sqliteAdapter.ts` — default provider (wraps `node:sqlite`).
- `services/api/src/db/postgresAdapter.ts` — `pg` pool, `?`→`$n` rewrite, scoped schema reset.
- `services/api/src/db/index.ts` — provider selection (`getAdapter`) + async `run/get/all/resetDb/closeDb`.
- `services/api/src/db/migrate.ts` + `migrate-cli.ts` — ordered migration runner.
- `supabase/migrations/20260912000000_init.sql` — `users`, `item_posts`, `attachments`, `comments`, `reactions`, `ratings`, `verification_challenges`, `uploads` + indexes/constraints.
- `services/api/src/tests/postgresAdapter.test.ts` — adapter unit tests with a fake client.

## How to apply (next, human-gated)

The connection string contains the database password and is **not** in the repo.
Supply it at run time only:

```bash
cd ~/GitHub/FindBack
DB_PROVIDER=postgres \
DATABASE_URL="postgresql://postgres:<DB_PASSWORD>@<host>:5432/postgres" \
npm run db:migrate
```

Get the URI from Supabase → Project Settings → Database → Connection string (URI).
Then start the API with the same two variables to exercise the Postgres path:

```bash
DB_PROVIDER=postgres DATABASE_URL="…" npm run dev:api
```

## What is needed from you

- **`DATABASE_URL`** (Supabase PostgreSQL connection URI with the DB password).
  Nothing else. `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` are for the later
  Auth/Storage phase and are **not** used by the database adapter.
- Do **not** paste the password into chat or commit it. Put it in the shell
  command above or in the gitignored `.env`.

## Compatibility notes (behavior preservation)

- **Case-insensitive uniqueness**: SQLite used `COLLATE NOCASE`; PostgreSQL uses
  `UNIQUE INDEX ... ON lower(username/email/phone)`. Queries already compare with
  `lower(...)`, so lookups are unchanged.
- **Booleans**: kept as `integer` 0/1 so `Boolean(row.x)` in the domain layer is unchanged.
- **Timestamps**: kept as ISO-8601 `text`; day-bucketing casts `created_at::date`.
- **Types**: the `pg` adapter sets int8/numeric parsers to `Number` so `COUNT(*)`/`AVG(score)` stay numbers.
- **Upserts**: `ON CONFLICT(post_id, user_id) DO UPDATE` is valid in both engines.
- **Reporting day series**: SQLite uses a recursive CTE; PostgreSQL uses
  `generate_series` (`domain/reportingService.ts` branches on `getAdapter().dialect`).

## Still depends on SQLite

- The **default** provider and all local/demo flows (`DB_PROVIDER` unset).
- The test suite (in-memory `:memory:` SQLite; `fileParallelism:false`).
- `npm run seed` and `npm run dev:api` until `DB_PROVIDER=postgres` + `DATABASE_URL` are set.
- The SQLite schema is duplicated in `sqliteAdapter.ts`; keep it in sync with the
  migration file when columns change.

## Verification (this pass)

- `npm run typecheck` — clean (all workspaces).
- `npm run lint` — clean.
- `npm test` — API **44/44** (8 files, includes 6 new adapter tests), mobile **5/5**.
- `npm run build -w @findback/api` — clean; `migrate.ts` discovers
  `20260912000000_init.sql`.
- **Not yet applied to Supabase** (no `DATABASE_URL`), so the Postgres schema is
  written and unit-tested but not executed against a live database.
