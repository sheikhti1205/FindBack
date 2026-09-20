# Supabase

This directory holds the Supabase side of FindBack: the PostgreSQL schema, RLS
hardening, and the backend RPCs. It is applied with the **Supabase CLI** to the
remote project.

```
supabase/
  migrations/
    20260912000000_init.sql                        # tables, constraints, indexes, RLS
    … (full chain; see filenames) …
    20260920000000_users_privacy_convergence.sql   # anon revoke, availability + public-profile RPCs
  functions/
    ai-help/                                       # Help Assistant Edge Function (deployed separately)
```

## Apply

```bash
# From the repo root, with SUPABASE_ACCESS_TOKEN set (CLI auth)
supabase link --project-ref "$SUPABASE_PROJECT_REF"  # first time only
supabase migration new <name>      # create a change
supabase db push --dry-run         # review
supabase db push                   # apply to the remote project (or dispatch backend-deploy.yml)
supabase migration list            # local vs remote
supabase functions deploy ai-help  # Edge Function (or dispatch backend-deploy.yml)
```

Applied migrations are recorded in `supabase_migrations.schema_migrations`.
Never edit an already-applied migration to change schema — add a new one. Do not
paste SQL into the Supabase Dashboard.

The Node API reaches the data through the Supabase **Data API** using
`@supabase/supabase-js` and the backend-only secret key; see
`docs/DATABASE_MIGRATION.md`. There is no direct PostgreSQL runtime connection.

## In scope now (was deferred)

Realtime private broadcast channels, direct Storage uploads under `<uid>/`,
and the `ai-help` Edge Function are all live and used by the mobile app (see
`docs/API_DEMO.md`). Auth and Storage are live: the public `findback-images`
bucket is created by a migration; the mobile app uploads directly under its
own `<uid>/` folder with owner-scoped RLS.
