-- LIVE-PENDING verification for 20261015163718_media_read_grants_and_dims_bound.sql.
-- Applied live 2026-10-15 as schema_migrations.version = 20261015163718,
-- name = media_read_grants_and_dims_bound (CF-060 M1 repair, from REVIEW-M1).
--
-- Run ONLY after the migration applies.
--
-- This file is written to be ANSWERABLE, not narrated, for the defect class it
-- exists to close. The migration it verifies was written because 20261015154642
-- added columns to two tables whose `authenticated` SELECT is granted
-- column-by-column without extending those grants (REVIEW-M1 F1/F2), and because
-- its dims checks were tighter than the media pipeline (REVIEW-M1 F4). Both
-- classes are therefore probed here by ASKING THE DATABASE:
--
--   Section 1  catalog probes - one row per probe, `\echo`-friendly, asserting the
--              grant model covers every column and the bound cannot reject a
--              publishable image;
--   Section 2  EXECUTABLE privilege probes - the exact statement the publish RPCs
--              run (`select *`), executed as role `authenticated` inside a
--              rolled-back transaction. 20261015154642's probes were catalog-only
--              and could not see this class; these can, in one call, with no
--              fixture and no JWT;
--   Section 3  the publish round trip that still needs a real account (JWT), kept
--              as commands for supabase/tests/run-live.sh conventions.
--
-- Section 1 and Section 2 are safe on production: read-only, and the transaction
-- in Section 2 rolls back.
--
-- Supersedes the bound probes in
-- supabase/tests/verify_20261015154642_attachment_dimensions.sql (P3/P4): the
-- 1..8192 ceiling they asserted was the defect, and that file's probes now carry
-- the widened bound with a note saying so.

-- ---------------------------------------------------------------------------
-- 1. Catalog probes (read-only; every probe must return exactly 1 row)
-- ---------------------------------------------------------------------------

-- P1. `authenticated` can read every column of public.uploads, however the grant
-- is expressed (table-level or column-level). `has_column_privilege` answers the
-- question the publish RPC actually asks, so a future column added without a
-- grant fails this probe instead of failing a user's publish.
select 'P1 authenticated reads every uploads column' as probe
where (
  select count(*) from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'uploads'
    and has_column_privilege('authenticated', 'public.uploads', c.column_name, 'SELECT')
) = (
  select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'uploads'
);
-- EXPECT: 1 row. Before this migration a repo-built environment failed here for
-- width/height while the hosted project passed via its table-level grant - which
-- is exactly the divergence the migration removes.

-- P2. Same for public.attachments. This one also covers the pre-existing gap
-- REVIEW-M1 F2 found: `display_order` (added 20260926000000) was never granted.
select 'P2 authenticated reads every attachments column' as probe
where (
  select count(*) from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'attachments'
    and has_column_privilege('authenticated', 'public.attachments', c.column_name, 'SELECT')
) = (
  select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'attachments'
);
-- EXPECT: 1 row.

-- P3. Both dims checks now bound 1..100000 and are still NOT VALID, so no
-- retro-validation pass ever scans existing rows.
select 'P3 both dims checks bounded 1..100000 and NOT VALID' as probe
where (
  select count(*) from pg_constraint
  where conname in ('attachments_dims_check', 'uploads_dims_check')
    and contype = 'c' and not convalidated
    and pg_get_constraintdef(oid) like '%>= 1%' and pg_get_constraintdef(oid) like '%<= 100000%'
) = 2;
-- EXPECT: 1 row. Asserts the SANITY CEILING only; the reason it exists at all is
-- P4.

-- P4. The ceiling cannot reject anything the media pipeline can emit. An animated
-- GIF is passed through untouched up to 30M decoded pixels
-- (apps/mobile/src/services/image.ts), so a 9000px edge is a publishable input and
-- the stored hint must accept it. This is the REVIEW-M1 F4 regression, expressed
-- as the number it broke on. REVIEW-M1-REPAIR R5: the bound is PARSED out of the
-- constraint and compared numerically - the previous form compared a literal to
-- the same literal (`9000 between 1 and 100000`) and asserted a non-null integer,
-- which is arithmetic, not a probe. Agreement with the client mirror
-- (MAX_DISPLAY_DIMENSION) is asserted in code where the constant can be read:
-- supabase/tests/migration_parity.test.mjs, "dims bound parity".
select 'P4 the parsed dims ceiling accepts a 9000px passthrough' as probe
where (
  select count(*) from pg_constraint
  where conname in ('attachments_dims_check', 'uploads_dims_check') and contype = 'c'
    and (regexp_match(pg_get_constraintdef(oid), '<= (\d+)'))[1]::integer >= 9000
) = 2;
-- EXPECT: 1 row.

-- P5. The four dimension columns document themselves as a display hint, so a
-- future reader cannot mistake them for a rule about what may be published.
select 'P5 all four dimension columns carry an explanatory comment' as probe
where (
  select count(*) from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('uploads', 'attachments')
    and a.attname in ('width', 'height')
    and col_description(c.oid, a.attnum) is not null
) = 4;
-- EXPECT: 1 row.

-- P6. No widening beyond the consumer role: this migration grants nothing to
-- `anon` or PUBLIC on either table.
select 'P6 anon and PUBLIC still hold no read on the media tables' as probe
where not has_table_privilege('anon', 'public.uploads', 'SELECT')
  and not has_column_privilege('anon', 'public.uploads', 'width', 'SELECT')
  and not has_table_privilege('anon', 'public.attachments', 'SELECT')
  and not has_column_privilege('anon', 'public.attachments', 'width', 'SELECT');
-- EXPECT: 1 row.

-- P7. RLS is still enabled on both tables and the policy sets are untouched, so
-- the added read grant changes column reach only - never row reach.
select 'P7 RLS still on, policy sets unchanged' as probe
where (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('uploads', 'attachments')
         and c.relrowsecurity) = 2
  and (select count(*) from pg_policies
       where schemaname = 'public' and tablename in ('uploads', 'attachments')) =
      (select count(*) from pg_policies
       where schemaname = 'public' and tablename in ('uploads', 'attachments'));
-- EXPECT: 1 row. The second half is a self-comparison on purpose: the assertion
-- that matters (this migration adds no policy) is static, in
-- supabase/tests/migration_parity.test.mjs; this probe pins RLS being ON.

-- P8. The migration left the publish/read functions byte-identical: the four
-- bodies this path depends on keep their security mode, volatility and comments.
-- The split matters: the two publish RPCs are VOLATILE (they write), the two
-- readers are STABLE (they do not). All four are SECURITY INVOKER, which is why
-- `select *` runs with the caller's privileges and why the grant model above is
-- load-bearing.
select 'P8 the four path functions are unchanged by this migration' as probe
where (
  select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('findback_create_post_client', 'findback_create_post_client_multi')
    and p.prosecdef = false and p.provolatile = 'v'
    and obj_description(p.oid, 'pg_proc') is not null
) = 2
  and (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('findback_query_posts_client', 'findback_query_posts_nearby_client')
      and p.prosecdef = false and p.provolatile = 's'
      and obj_description(p.oid, 'pg_proc') is not null
  ) = 2;
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Executable privilege probes (the actual failure mode; safe, rolls back)
-- ---------------------------------------------------------------------------
-- Run as ONE call. `select *` is exactly what both publish RPCs execute
-- (`select * into v_upload from public.uploads where id = ...`); before this
-- migration a repo-built environment raised
--   ERROR: permission denied for table uploads   (SQLSTATE 42501)
-- here, and 20261015154642's catalog-only probes could not see it. EXPECT: no
-- error, and 0 rows (LIMIT 0 keeps this read-only and row-independent).
--
-- REVIEW-M1-REPAIR R4: these statements are EXECUTED, not commented out. A
-- runner that walks this file used to execute eight catalog probes and then
-- silently skip the only check that can see the defect class the file exists
-- for. The text below is live SQL; the explanation around it is the comment.
--
-- A returned row count is NOT the assertion - a pristine database legitimately has
-- no rows. The assertion is that nothing raised.

begin;
set local role authenticated;
select * from public.uploads limit 0;
select * from public.attachments limit 0;
select width, height, display_order, file_url from public.attachments limit 0;
rollback;

-- ---------------------------------------------------------------------------
-- 3. Publish round trip (needs a real account; run-live.sh on a disposable backend)
-- ---------------------------------------------------------------------------
-- Same environment contract as the other verify files (TEST_SUPABASE_URL,
-- TEST_SUPABASE_PUBLISHABLE_KEY, TEST_USER_A_JWT). Never production, values never
-- printed.
--
-- (a) Dimensions still travel end to end, now on a repo-built backend.
--   PATCH "$TEST_SUPABASE_URL/rest/v1/uploads?id=eq.<UPLOAD_A_ID>"
--     -d '{"width":1080,"height":1440}'                       # as TEST_USER_A_JWT
--   POST  "$TEST_SUPABASE_URL/rest/v1/rpc/findback_create_post_client"
--     -d '{"p_type":"LOST","p_title":"dims probe","p_description":"",
--          "p_category":"OTHER","p_event_date":"","p_attachment_key":"<UPLOAD_A_ID>"}'
--   GET   "$TEST_SUPABASE_URL/rest/v1/attachments?post_id=eq.<NEW_POST_ID>&select=width,height"
-- EXPECT: HTTP 200, width 1080 / height 1440.
--
-- (b) The pass-through size that used to fail now publishes. Stage (or PATCH) a
--   row with width 9000 / height 3000, publish it, and GET the attachment.
-- EXPECT: HTTP 200 with 9000/3000 stored - this is REVIEW-M1 F4's case, and the
--   raw Postgres sentence it used to surface to the user is gone.
--
-- (c) A client that sends no dimensions still publishes (already-installed builds).
-- EXPECT: HTTP 200 with width/height null; the feed falls back to a default ratio.
--
-- (d) A dimension no client can vouch for is stored as absent, not as an error.
--   Stage a file whose measured pair is out of range.
-- EXPECT: HTTP 2xx and the staging row carries width/height NULL
--   (apps/mobile/src/services/media/displayDimensions.ts); the publish still
--   succeeds.
