# Supabase

This directory holds the Supabase side of FindBack: the PostgreSQL schema, RLS
hardening, and the backend RPCs. It is applied with the **Supabase CLI** to the
remote project.

```
supabase/
  migrations/
    20260912000000_init.sql                        # tables, constraints, indexes, RLS
    20260912170500_restrict_rls_auto_enable.sql    # lock down the RLS helper function
    20260912181321_supabase_feed_and_report_rpcs.sql # findback_query_posts, findback_report
    20260912190128_auth_password_hash_nullable.sql # Supabase Auth owns passwords
    20260914062145_create_findback_images_bucket.sql # public findback-images bucket
```

## Apply

```bash
# From the repo root, logged in with `npx supabase login`
npx supabase migration new <name>      # create a change
npx supabase db push --dry-run         # review
npx supabase db push                   # apply to the remote project
npx supabase migration list            # local vs remote
```

Applied migrations are recorded in `supabase_migrations.schema_migrations`.
Never edit an already-applied migration to change schema — add a new one. Do not
paste SQL into the Supabase Dashboard.

The Node API reaches the data through the Supabase **Data API** using
`@supabase/supabase-js` and the backend-only secret key; see
`docs/DATABASE_MIGRATION.md`. There is no direct PostgreSQL runtime connection.

## Not in scope yet

Realtime and Edge Functions are intentionally untouched. Those are wired in a
later phase (see `docs/DEFERRED_DECISIONS.md`). Auth and Storage are live: the
public `findback-images` bucket is created by a migration and written to only by
the Node backend (`docs/DATABASE_MIGRATION.md`).
