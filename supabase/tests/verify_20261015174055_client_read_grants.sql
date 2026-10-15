-- LIVE-PENDING verification for 20261015174749_client_read_grants_invoker_paths.sql.
-- Applied live 2026-10-15 as schema_migrations.version = 20261015174749 (the
-- apply tool stamps the version at apply time), name =
-- client_read_grants_invoker_paths.
--
-- Provenance: schema_migrations.statements[1] for that version is byte-identical
-- to the repo file - md5 5477a2df12ed4083a56cfa09887d6fbd, 4467 bytes - so the
-- record and the artifact agree without any post-apply realignment
-- (REVIEW-M1-REPAIR R6).
--
-- This verify file keeps the name it was first authored with
-- (20261015174055_...): the applied migration's own LIVE-PENDING pointer names
-- it, and applied migration files are never edited after the fact. The version
-- to look up in schema_migrations is 20261015174749.
--
-- CF-060 M1 repair follow-up, from REVIEW-M1-REPAIR R1 and the repo-wide
-- CLIENT-ACL-ANALYSIS.
--
-- Run ONLY after the migration applies.
--
-- This file is written to be ANSWERABLE, not narrated, for the defect class it
-- closes. The migration exists because two columns that SECURITY INVOKER
-- readers ask for were never in the column grants on public.comments and
-- public.reactions, which is the same class 20261015163718 repaired for the
-- media tables: a column list does not cover a column added later, and a reader
-- that is invoker fails in the caller's own context.
--
--   Section 1  catalog probes - one row per probe, `\echo`-friendly, asserting
--              the grant model now covers the reads;
--   Section 2  EXECUTABLE read probes - the exact column lists the four readers
--              expand to, executed as role `authenticated` inside a rolled-back
--              transaction. Catalog probes alone cannot see this class; these
--              can, in one call, with no fixture and no JWT.
--
-- Both sections are safe on production: read-only, and Section 2 rolls back.
-- Section 1 additionally pins that the migration widened nothing beyond
-- `authenticated` and touched no policy - the same shape as the media file.

-- ---------------------------------------------------------------------------
-- 1. Catalog probes (read-only; every probe must return exactly 1 row)
-- ---------------------------------------------------------------------------

-- P1. `authenticated` can read every column of public.comments, however the
-- grant is expressed. After this migration the repository's own column list is
-- exhaustive for the table (the 6 columns of 20260914200000 plus parent_id and
-- depth); the hosted project passes via its table-level grant. Both models agree
-- from here, and a future column added without a grant fails this probe instead
-- of failing a user's comment screen.
select 'P1 authenticated reads every comments column' as probe
where (
  select count(*) from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'comments'
    and has_column_privilege('authenticated', 'public.comments', c.column_name, 'SELECT')
) = (
  select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'comments'
);
-- EXPECT: 1 row. Before this migration a repo-built environment failed here for
-- parent_id and depth while the hosted project passed - the divergence the
-- migration removes.

-- P2. `authenticated` can read public.reactions.user_id, the column the two feed
-- readers sub-select for the caller's own-reaction flag. This is the single most
-- load-bearing probe in the file: without it neither feed RPC can run at all in
-- a repo-built environment.
select 'P2 authenticated reads reactions.user_id' as probe
where has_column_privilege('authenticated', 'public.reactions', 'user_id', 'SELECT');
-- EXPECT: 1 row.

-- P3. The four readers this migration serves are still SECURITY INVOKER - the
-- grant, and not a definer rewrite, is what makes them work. A reader flipped to
-- DEFINER would pass the read probes above while changing who the read runs as,
-- so the mode is asserted, not assumed.
select 'P3 all four readers are still SECURITY INVOKER' as probe
where (
  select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef = false
    and p.proname in (
      'findback_list_comments_client',
      'findback_add_comment_client',
      'findback_query_posts_client',
      'findback_query_posts_nearby_client'
    )
) = 4;
-- EXPECT: 1 row.

-- P4. The tree reader still DECLARES the two columns the grant now covers, so
-- P1/P2 are serving a shape the client actually consumes rather than a column
-- nobody asks for.
select 'P4 the comments reader still returns parent_id and depth' as probe
where (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'findback_list_comments_client'
         and pg_get_function_result(p.oid) like '%parent_id%'
         and pg_get_function_result(p.oid) like '%depth%') = 1;
-- EXPECT: 1 row.

-- P5. No widening beyond the consumer role: this migration grants nothing to
-- `anon` or PUBLIC on either table.
select 'P5 anon still holds no read on comments or reactions' as probe
where not has_table_privilege('anon', 'public.comments', 'SELECT')
  and not has_column_privilege('anon', 'public.comments', 'parent_id', 'SELECT')
  and not has_table_privilege('anon', 'public.reactions', 'SELECT')
  and not has_column_privilege('anon', 'public.reactions', 'user_id', 'SELECT');
-- EXPECT: 1 row.

-- P6. RLS is still enabled on both tables, so the added read grant changes column
-- reach only - never row reach. The assertion that this migration adds no policy
-- is static, in supabase/tests/migration_parity.test.mjs; this probe pins RLS
-- being ON, which is what keeps the added reach row-scoped.
select 'P6 RLS still on for both tables' as probe
where (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('comments', 'reactions')
         and c.relrowsecurity) = 2;
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Executable read probes (the actual failure mode; safe, rolls back)
-- ---------------------------------------------------------------------------
-- Run as ONE call, after Section 1. These are the column lists the readers
-- expand to. Before this migration a repo-built environment raised
--   ERROR: permission denied for table comments    (SQLSTATE 42501)
--   ERROR: permission denied for table reactions   (SQLSTATE 42501)
-- here, and catalog-only probes of the kind 20261015154642 shipped could not see
-- it. EXPECT: no error. LIMIT 0 keeps this read-only and row-independent, so it
-- is equally valid on a pristine database; the assertion is that nothing raised.

begin;
set local role authenticated;
select id, post_id, parent_id, depth, body, created_at, updated_at, user_id
  from public.comments limit 0;
select id, post_id, type, user_id from public.reactions limit 0;
rollback;

-- ---------------------------------------------------------------------------
-- 3. Round trip that needs a real account (JWT)
-- ---------------------------------------------------------------------------
-- Same environment contract as the other verify files (TEST_SUPABASE_URL,
-- TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT). Never production, values
-- never printed.
--
-- (a) Feed: `findback_query_posts_client` returns rows as the signed-in user,
--     which it cannot do while reactions.user_id is unreadable.
--   POST "$TEST_SUPABASE_URL/rest/v1/rpc/findback_query_posts_client"
--        -H "apikey: $TEST_SUPABASE_PUBLISHABLE_KEY"
--        -H "Authorization: Bearer $TEST_USER_A_JWT" -d '{}'
--   EXPECT: HTTP 200 and a JSON array (possibly empty), never a 42501 body.
--
-- (b) Comments: list and reply on a post the user can see.
--   POST "$TEST_SUPABASE_URL/rest/v1/rpc/findback_list_comments_client"
--        -d '{"p_post_id":"<POST_ID>"}'
--   POST "$TEST_SUPABASE_URL/rest/v1/rpc/findback_add_comment_client"
--        -d '{"p_post_id":"<POST_ID>","p_body":"reply","p_parent_id":"<COMMENT_ID>"}'
--   EXPECT: 200 with parent_id/depth present on threaded rows.
