# API demonstration — REST, GraphQL, reporting

FindBack's real API is the hosted Supabase project. PostgREST serves the REST
(Data API) endpoints and `pg_graphql` serves GraphQL, both resolving every
request **as the JWT role** so grants + Row Level Security are enforced in the
database. The legacy Express REST + GraphQL-Yoga server remains in the repo as a
Docker/coursework reference but is no longer the runtime API for the app.

Base URL: `https://<project-ref>.supabase.co` (set via `SUPABASE_URL`). Examples
use **only the publishable key** (safe to ship) plus a user access token. Never
put the secret/service key in a client or an example.

All four examples below were executed live against the hosted project and are
reproduced by the temporary verifier `10i-verify.mjs` (14/14 checks).

## REST (PostgREST / Data API)

### 1. Username availability — anonymous, `username` column only

The register form's live "available/taken" check reads one public column before
authentication.

```bash
curl "$SUPABASE_URL/rest/v1/users?select=username&username=eq.rafi_cu" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY"
# → [{"username":"rafi_cu"}]
```

`anon` has a column grant on `users.username` only. Asking for anything else is
rejected: `GET /rest/v1/users?select=email` → `401 permission denied for table users`.

### 2. Feed — authenticated, client-safe RPC

The app never selects the feed table directly; it calls the sanitising RPC.

```bash
curl -X POST "$SUPABASE_URL/rest/v1/rpc/findback_query_posts_client" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"p_limit":10,"p_q":"calculator"}'
```

Each row carries the author's **public** projection (`author_username`,
`author_email_verified`, `author_phone_verified`, `author_avatar_url`,
`author_created_at`) and the aggregate counts — never `author_email`,
`author_phone`, or any `reactions`/`ratings` user id.

### 3. Post table — authenticated read

```bash
curl "$SUPABASE_URL/rest/v1/item_posts?select=id,title,status&limit=10" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer <access_token>"
```

`anon` has no grant on `item_posts` (`GET /rest/v1/item_posts` → `401`), and the
SELECT policy on `reactions`/`ratings` exposes aggregate columns only.

## GraphQL (`/graphql/v1`, pg_graphql)

Enabled by `supabase/migrations/20260914230000_enable_pg_graphql.sql`
(`create extension if not exists pg_graphql with schema graphql`). Types and
fields are filtered by the request role's grants, and rows by RLS — so the
schema an `authenticated` client sees already excludes `users.email`/`phone`.
Field names are the literal table names (`item_postsCollection`,
`usersCollection`); schema introspection is disabled.

```bash
curl -X POST "$SUPABASE_URL/graphql/v1" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ item_postsCollection(first: 1) { edges { node { id title status } } } }"}'
```

```graphql
# Public profile lookup — email is not part of the authenticated schema
{
  usersCollection(first: 1) {
    edges { node { username } }
  }
}
```

- Authenticated: `item_postsCollection` and `usersCollection` resolve.
- Anonymous: `item_postsCollection` is not even a field
  (`Unknown field "item_postsCollection" on type Query`).
- `users { email }` → `Unknown field 'email' on type 'users'`.

## Reporting (request #20)

The activity bundle is a single JSONB RPC, `public.findback_report(p_days,
p_top_limit)` (summary, byDay, byType, byStatus, byCategory, topContributors).
It reads private-ish aggregates, so it stays **`service_role`-only**;
`anon`/`authenticated` get `401`. It is consumed by the reference server's
`/reports/activity` route and `scripts/report-activity.mjs`, and CSV can be
generated client-side from the JSON. The licensed Crystal `.rpt` design file
remains `DEFERRED_EXTERNAL_TOOL`.

```bash
curl -X POST "$SUPABASE_URL/rest/v1/rpc/findback_report" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" -d '{"p_days":7,"p_top_limit":5}'
```

## AI Help (Supabase Edge Function)

`POST /functions/v1/ai-help` — JWT-verified, authenticated users only.

```bash
curl -X POST "$SUPABASE_URL/functions/v1/ai-help" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"question":"how do I report a lost item?"}'
# → {"text":"…","source":"fallback"}
```

With no provider secret configured the deterministic fallback answers
(`source: "fallback"`); setting `LLM_BASE_URL` + `LLM_API_KEY` Edge Function
secrets switches it to a real OpenAI-compatible model (`source: "llm"`). An
unauthenticated call is rejected before the handler, and empty/over-long
questions return `400`.

## RLS behaviour summary

| Caller | Feed (`item_posts`) | `users` | Social user ids | `findback_report` |
| --- | --- | --- | --- | --- |
| `anon` | denied (no grant) | `username` only | denied | denied |
| `authenticated` | allowed (RLS) | public columns only | never exposed | denied |
| `service_role` | allowed (bypasses RLS) | all columns | all columns | allowed |
