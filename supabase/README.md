# Supabase

This directory holds the PostgreSQL/Supabase side of FindBack. It is applied by
the API's migration runner (`npm run db:migrate` in `services/api`), not by the
Supabase CLI, so no local Supabase project or CLI install is required.

```
supabase/
  migrations/
    20260912000000_init.sql   # users, item_posts, attachments, comments,
                              # reactions, ratings, verification_challenges, uploads
```

## Apply

```bash
cd services/api
DB_PROVIDER=postgres \
DATABASE_URL="postgresql://postgres:<DB_PASSWORD>@<host>:5432/postgres" \
npm run db:migrate
```

Applied files are recorded in `public.schema_migrations`, so re-running is safe.
The same SQL can be pasted into the Supabase SQL editor if you prefer.

## Not in scope yet

Auth, Storage, Realtime and Edge Functions are intentionally untouched. Those
are wired in a later phase (see `docs/DEFERRED_DECISIONS.md`).
