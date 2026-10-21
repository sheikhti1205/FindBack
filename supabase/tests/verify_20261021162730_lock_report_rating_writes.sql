-- Readback for 20261021162730_lock_report_rating_writes.sql
--
-- APPLIED to the hosted project on 2026-10-21 (hosted version 20261021162730).
-- The hosted readback (a single-batch behaviour probe that ends in ROLLBACK,
-- plus a catalog probe) is recorded in
-- FindBack-internal/01_ACTIVE/consumer-final/sessions/main/D2-hosted-postapply-2026-10-21.json.
-- The probes below are written to be run by the database owner.
--
-- Run AFTER the migration is applied. Every probe states what it expects, so
-- the output is evidence rather than a vibe.
--
-- Expected results (hosted project, schema `public`):
--   P1  policies on `ratings` → only `ratings_select_authenticated`
--   P2  table privileges     → `authenticated` holds SELECT only
--   P3  function privileges  → `findback_rate_client` is NOT executable by
--                              `authenticated`/`anon`/`public`; `service_role`
--                              and `postgres` still are
--   P4  the ratings rows are still there (nothing was deleted)

-- P1: no client write policy survives.
select policyname, cmd, roles::text
from pg_policies
where schemaname = 'public' and tablename = 'ratings'
order by policyname;
-- EXPECT: exactly one row — `ratings_select_authenticated` / SELECT.
-- Any `ratings_insert_own` or `ratings_delete_own` row means the lockdown did
-- not take effect.

-- P2: the client role holds no write privilege on the table.
select grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'ratings'
  and grantee in ('authenticated', 'anon')
order by grantee, privilege_type;
-- EXPECT: `authenticated` holds SELECT only. No INSERT/UPDATE/DELETE rows.

-- P3: the rating RPC is closed to clients.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'findback_rate_client'
order by grantee;
-- EXPECT: no `authenticated` and no `anon` row; `postgres` and `service_role`
-- rows are present.

-- P4: the history is intact — the lockdown removes access, not data.
select count(*) as rating_rows from public.ratings;
-- EXPECT: the same count as before the migration (5 in the reviewed snapshot).
