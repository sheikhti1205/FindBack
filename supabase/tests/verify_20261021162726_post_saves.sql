-- Verification for 20261021162726_post_saves.sql (saved reports).
--
-- STATUS, STATED PLAINLY. The migration this file verifies WAS applied to
-- the hosted project on 2026-10-21 (hosted version 20261021162726), and the
-- hosted readback that proves the security properties below is recorded in
-- FindBack-internal/01_ACTIVE/consumer-final/sessions/main/D2-hosted-postapply-2026-10-21.json
-- (a single-batch behaviour probe that ends in ROLLBACK, plus a catalog
-- probe). THE PROBES IN THIS FILE WERE NOT EXECUTED IN THAT PASS: the
-- behavioural section still needs a disposable PostgreSQL 17 with the whole
-- migration chain applied on top. Nothing here may be quoted as a passing
-- result until it has been run and its output recorded.
--
-- HOW TO RUN IT. Section 1 is read-only catalog probes: run them in the
-- Supabase dashboard SQL editor (or as the database owner) after the
-- migration is applied. Section 2 is behavioural: it switches to the
-- `authenticated` role with a JWT subject claim
-- (`set_config('request.jwt.claim.sub', <uid>, false)`) and writes scratch
-- rows, so run it on a DISPOSABLE PostgreSQL 17 with the whole migration
-- chain applied on top — never on production, and wrap it in a transaction
-- that ROLLBACKs. Section 3 is the post-apply READBACK: the exact queries to
-- run against the hosted project once the migration has been applied, to
-- show that the table, the RLS state, the policies, the RPCs and their
-- grants are what the migration intended.
--
-- The security properties under test, in the order the migration states them:
--   1. the caller comes from auth.uid() and from nothing else;
--   2. every RPC is SECURITY DEFINER with a locked search_path;
--   3. anon and public hold nothing;
--   4. RLS is on and every policy is owner-scoped;
--   5. a save verifies the report exists in public.item_posts;
--   6. the rows disappear with their owner.

-- ---------------------------------------------------------------------------
-- 1. Read-only catalog probes.
-- ---------------------------------------------------------------------------

-- P1. The table exists, RLS is enabled, and NO client role holds a table
--     privilege: the RPCs are the only surface.
select 'P1 table locked down' as probe
where exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'post_saves'
)
and exists (
  select 1 from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'post_saves' and c.relrowsecurity
)
and not has_table_privilege('anon', 'public.post_saves', 'SELECT')
and not has_table_privilege('anon', 'public.post_saves', 'INSERT')
and not has_table_privilege('anon', 'public.post_saves', 'DELETE')
and not has_table_privilege('authenticated', 'public.post_saves', 'SELECT')
and not has_table_privilege('authenticated', 'public.post_saves', 'INSERT')
and not has_table_privilege('authenticated', 'public.post_saves', 'DELETE');
-- EXPECT: 1 row.

-- P2. Every policy on the table is owner-scoped: each one names auth.uid()
--     and no policy grants another reader's rows.
select 'P2 policies are owner-scoped' as probe
where not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'post_saves'
    and (
      roles <> array['authenticated']::name[]
      or (cmd in ('SELECT', 'DELETE') and coalesce(qual, '') not like '%auth.uid()%')
      or (cmd = 'INSERT' and coalesce(with_check, '') not like '%auth.uid()%')
      or cmd not in ('SELECT', 'INSERT', 'DELETE')
    )
)
and exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'post_saves'
);
-- EXPECT: 1 row.

-- P3. The three client RPCs exist, are SECURITY DEFINER, lock their
--     search_path, and are granted to `authenticated` only.
select 'P3 client RPCs are definer, locked and authenticated-only' as probe
where (
  select count(*)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_save_post_client',
      'findback_unsave_post_client',
      'findback_list_saved_posts_client'
    )
    and p.prosecdef
    and p.proconfig @> array['search_path=public, pg_temp']::text[]
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    -- PUBLIC is ACL grantee 0, not a login role usable by
    -- has_function_privilege(text, oid, text).
    and not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    )
) = 3;
-- EXPECT: 1 row.

-- P4. NO RPC takes a user id: the caller can only come from auth.uid(). A
--     parameter that carried a user id would be the cross-account defect.
select 'P4 no client-supplied user id' as probe
where not exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'findback_save_post_client',
      'findback_unsave_post_client',
      'findback_list_saved_posts_client'
    )
    and exists (
      select 1 from unnest(p.proargnames) as arg(name)
      where lower(name) like '%user%' or lower(name) like '%uid%'
    )
);
-- EXPECT: 1 row.

-- P5. The save RPC verifies the report against `public.item_posts` — the
--     table every other client RPC in this chain checks against
--     (findback_add_comment_client) — instead of inventing a private rule.
select 'P5 save verifies the report exists' as probe
where exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_save_post_client'
    and position('item_posts' in pg_get_functiondef(p.oid)) > 0
);
-- EXPECT: 1 row.

-- P6. The column types are the ones the hosted schema actually uses: the
--     report id and the account id are TEXT (public.item_posts.id and
--     public.users.id are text), and created_at is TEXT in the house format.
select 'P6 column types match the hosted schema' as probe
where (
  select count(*)
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'post_saves'
    and (
      (c.column_name = 'post_id' and c.data_type = 'text')
      or (c.column_name = 'user_id' and c.data_type = 'text')
      or (c.column_name = 'created_at' and c.data_type = 'text')
    )
) = 3;
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Behavioural probes (disposable backend only; wrap in a transaction and
--    ROLLBACK). Setup: two accounts A and B, each with one PUBLISHED report
--    (P_A, P_B), and a report id that does not exist.
-- ---------------------------------------------------------------------------

-- (a) AS A: findback_save_post_client(P_A) returns true, and the stored row
--     belongs to A.
-- EXPECT: true; one row in post_saves with post_id = P_A and user_id = A.

-- (b) AS A: findback_save_post_client(P_A) a second time returns true and
--     leaves exactly ONE row (the composite primary key prevents duplicates)
--     and refreshes its server save clock for newer-intent reconciliation.
-- EXPECT: true; still one row.

-- (c) AS B: findback_list_saved_posts_client() does NOT return P_A.
-- EXPECT: one complete JSON envelope whose items contain no post_id = P_A.
-- An otherwise empty account returns {"complete":true,"items":[]}.

-- (d) AS B: findback_unsave_post_client(P_A) returns true and A's row
--     SURVIVES — the delete is scoped to the caller's own rows.
-- EXPECT: true; A's row still present.

-- (e) AS A: findback_save_post_client('<a report id that does not exist>')
--     raises P0002 and stores nothing.
-- EXPECT: SQLSTATE P0002; zero new rows.

-- (f) AS A: the stored created_at is the house text format
--     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' and is castable to a timestamp.
-- EXPECT: one row whose created_at matches that pattern.

-- (g) AS ANON (set role anon): every one of the three RPCs raises 42501
--     (permission denied for function).
-- EXPECT: three 42501 errors, no rows written.

-- (h) NO SESSION (auth.uid() is null): each RPC raises 28000 (invalid
--     authorization specification).
-- EXPECT: three 28000 errors, no rows written.

-- (i) CASCADE: deleting account A removes A's post_saves rows (the user_id
--     foreign key cascades), and deleting a report removes its save rows.
-- EXPECT: zero rows for A afterwards.

-- (j) AS A: inspect the scalar snapshot, not an assumed table result:
--     SELECT jsonb_typeof(public.findback_list_saved_posts_client()) = 'object';
--     SELECT public.findback_list_saved_posts_client()->'complete' = 'true'::jsonb;
--     SELECT jsonb_typeof(public.findback_list_saved_posts_client()->'items') = 'array';
-- EXPECT: all true. Expand items with jsonb_array_elements to inspect post_id
-- and saved_at; the item count matches all of A's saved rows, including >200.
-- An invalid/missing envelope must not be interpreted as an empty complete list.

-- ---------------------------------------------------------------------------
-- 3. POST-APPLY READBACK (hosted project, after the migration is applied).
--    These are the exact queries to run to show that what landed is what
--    the migration intended. Read-only; safe to run in the dashboard SQL
--    editor. Expected results are stated under each query.
-- ---------------------------------------------------------------------------

-- R1. The table exists, with the intended columns, types and constraints.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'post_saves'
order by ordinal_position;
-- EXPECT: post_id (text, NOT NULL, no default), user_id (text, NOT NULL, no
-- default), created_at (text, NOT NULL, no default).

select tc.constraint_name, tc.constraint_type, kcu.column_name,
       ccu.table_name as referenced_table, ccu.column_name as referenced_column
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
left join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
where tc.table_schema = 'public' and tc.table_name = 'post_saves'
order by tc.constraint_name, kcu.ordinal_position;
-- EXPECT: a PRIMARY KEY over (post_id, user_id), and two FOREIGN KEYs —
-- post_id -> public.item_posts(id), user_id -> public.users(id), both
-- ON DELETE CASCADE.

-- R2. RLS is enabled and the table is granted to no client role.
select c.relrowsecurity as rls_enabled,
       has_table_privilege('anon', 'public.post_saves', 'SELECT') as anon_select,
       has_table_privilege('anon', 'public.post_saves', 'INSERT') as anon_insert,
       has_table_privilege('anon', 'public.post_saves', 'DELETE') as anon_delete,
       has_table_privilege('authenticated', 'public.post_saves', 'SELECT') as auth_select,
       has_table_privilege('authenticated', 'public.post_saves', 'INSERT') as auth_insert,
       has_table_privilege('authenticated', 'public.post_saves', 'DELETE') as auth_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'post_saves';
-- EXPECT: rls_enabled = true and every privilege column = false.

-- R3. The three owner-scoped policies, and no fourth one.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'post_saves'
order by policyname;
-- EXPECT exactly three rows: post_saves_select_own (select),
-- post_saves_insert_own (insert), post_saves_delete_own (delete); roles =
-- {authenticated}; every qual / with_check contains auth.uid() and names
-- only user_id.

-- R4. The three RPCs exist with the intended signatures and are SECURITY
--     DEFINER with a locked search_path.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as returns,
       p.prosecdef as security_definer,
       p.proconfig as function_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'findback_save_post_client',
    'findback_unsave_post_client',
    'findback_list_saved_posts_client'
  )
order by p.proname;
-- EXPECT: three rows. findback_save_post_client(p_post_id text) returns
-- boolean; findback_unsave_post_client(p_post_id text) returns boolean;
-- findback_list_saved_posts_client() returns jsonb with complete:true and
-- items:[{post_id,saved_at}]. All three: security_definer = true, function_settings
-- contains {search_path=public, pg_temp}.

-- R5. The grants: `authenticated` may EXECUTE the three RPCs; anon and
--     PUBLIC may not. Owner/service administrative grants are not clients.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name in (
    'findback_save_post_client',
    'findback_unsave_post_client',
    'findback_list_saved_posts_client'
  )
order by routine_name, grantee, privilege_type;
-- EXPECT: only grantee = authenticated with privilege_type = EXECUTE, one
-- row per routine. No row for anon, and no row for PUBLIC.

-- R6. The functions take NO user id: the caller can only come from
--     auth.uid().
select p.proname, p.proargnames, p.proargtypes
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'findback_save_post_client',
    'findback_unsave_post_client',
    'findback_list_saved_posts_client'
  )
order by p.proname;
-- EXPECT: findback_save_post_client -> {p_post_id}; the unsave one ->
-- {p_post_id}; the list one -> NULL (no arguments). No argument name
-- contains 'user' or 'uid'.

-- R7. The body of each RPC takes the caller from auth.uid() and reads
--     public.item_posts — the table the hosted schema actually uses.
select p.proname, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'findback_save_post_client',
    'findback_unsave_post_client',
    'findback_list_saved_posts_client'
  )
order by p.proname;
-- EXPECT: every definition contains `auth.uid()::text`; the save one
-- contains `from public.item_posts`; the unsave one deletes only rows whose
-- user_id equals the caller's id; none of them accepts a user id.
