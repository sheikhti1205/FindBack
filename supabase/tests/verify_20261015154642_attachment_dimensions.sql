-- LIVE-PENDING verification for 20261015154642_attachment_dimensions.sql.
-- Applied live 2026-10-15 as schema_migrations.version = 20261015154642,
-- name = attachment_dimensions (CF-060 M1 / IF-101).
--
-- Run ONLY after the migration applies. Section 1 is read-only catalog probes
-- (database owner session, e.g. the dashboard SQL editor or an owner-run
-- execute_sql). Section 2 documents the live-run behavioral probes: run them on
-- a disposable test backend under the supabase/tests/run-live.sh conventions --
-- same env contract (TEST_SUPABASE_URL, TEST_SUPABASE_PUBLISHABLE_KEY,
-- TEST_USER_A_JWT), never against production, values never printed.
--
-- What this migration closes: report attachments and staging uploads carried no
-- display dimensions, so the consumer feed could not lay out a natural-ratio /
-- masonry grid without a client-side measurement round trip. The comment path
-- (public.comment_attachments) already solved this with nullable width/height
-- plus a bounded dims check; this migration mirrors that convention onto the
-- report path and carries the values through both publish RPCs and both consumer
-- readers.
--
-- Contract notes recorded with the migration:
--   * columns are nullable and NOT backfilled: no production image is fetched to
--     fill a column, and legacy rows keep rendering through the client's ratio
--     fallback;
--   * both dims checks are NOT VALID on purpose (same as
--     comment_attachments_dims_check): they govern every new write while no
--     retro-validation pass ever scans existing rows;
--   * no RLS policy, grant or function signature changes: the touched tables keep
--     their authenticated-only DML grants and their existing policy set;
--   * findback_query_posts (legacy, non-client reader used by services/api) is
--     deliberately not redefined: it is not on the consumer feed path.

-- ---------------------------------------------------------------------------
-- 1. Catalog probes (read-only; every probe must return exactly 1 row)
-- ---------------------------------------------------------------------------

-- P1. Both report-attachment columns exist, nullable, integer.
select 'P1 attachments carries nullable integer width+height' as probe
where (
  select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'attachments'
    and column_name in ('width', 'height')
    and data_type = 'integer' and is_nullable = 'YES'
) = 2;
-- EXPECT: 1 row. A NOT NULL column here would break every already-installed
-- client that publishes without dimensions.

-- P2. Same for the staging row the publish RPC copies from.
select 'P2 uploads carries nullable integer width+height' as probe
where (
  select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'uploads'
    and column_name in ('width', 'height')
    and data_type = 'integer' and is_nullable = 'YES'
) = 2;
-- EXPECT: 1 row.

-- P3. attachments_dims_check bounds both columns 1..8192 and is NOT VALID.
select 'P3 attachments_dims_check bounded 1..8192 and NOT VALID' as probe
where exists (
  select 1 from pg_constraint
  where conrelid = 'public.attachments'::regclass
    and conname = 'attachments_dims_check'
    and contype = 'c'
    and not convalidated
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%width>=1%width<=8192%height>=1%height<=8192%'
);
-- EXPECT: 1 row. `not convalidated` is the point: adding a validated check
-- would force a full-table scan of production rows for no benefit.

-- P4. Same guarantee on the staging table, so a bogus dimension cannot be
-- staged and then copied across.
select 'P4 uploads_dims_check bounded 1..8192 and NOT VALID' as probe
where exists (
  select 1 from pg_constraint
  where conrelid = 'public.uploads'::regclass
    and conname = 'uploads_dims_check'
    and contype = 'c'
    and not convalidated
    and regexp_replace(lower(pg_get_constraintdef(oid)), '\s', '', 'g')
        like '%width>=1%width<=8192%height>=1%height<=8192%'
);
-- EXPECT: 1 row.

-- P5. The single-key publish path copies the staged dimensions across.
select 'P5 findback_create_post_client copies staging upload dims' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_create_post_client'
    and p.prosecdef = false
    and p.prosrc like '%v_upload.width, v_upload.height%'
    and p.prosrc like '%width, height%'
);
-- EXPECT: 1 row. Without this the single-key path would write NULL dims and only
-- multi-image posts would get a natural ratio.

-- P6. The multi-key publish path copies them the same way (no divergence
-- between the two publish entry points).
select 'P6 findback_create_post_client_multi copies staging upload dims' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_create_post_client_multi'
    and p.prosecdef = false
    and p.prosrc like '%v_upload.width, v_upload.height%'
    and p.prosrc like '%display_order%'
);
-- EXPECT: 1 row.

-- P7. The main consumer feed returns the two keys inside the attachment jsonb.
select 'P7 findback_query_posts_client returns width+height' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_query_posts_client'
    and p.prosrc like '%''width'', a.width%'
    and p.prosrc like '%''height'', a.height%'
);
-- EXPECT: 1 row.

-- P8. The nearby feed returns them too, so both feed modes share one ratio
-- source.
select 'P8 findback_query_posts_nearby_client returns width+height' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_query_posts_nearby_client'
    and p.prosrc like '%''width'', a.width%'
    and p.prosrc like '%''height'', a.height%'
);
-- EXPECT: 1 row.

-- P9. The legacy non-client reader was deliberately left alone (blast radius).
select 'P9 legacy findback_query_posts not redefined' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_query_posts'
    and p.prosrc not like '%a.width%'
);
-- EXPECT: 1 row. services/api keeps the shape it was built against.

-- P10. All four signatures, security mode and volatility are unchanged, so no
-- caller (client or grant) can break.
select 'P10 signatures, security and volatility unchanged' as probe
where exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_create_post_client'
    and p.prosecdef = false and p.provolatile = 'v'
    and pg_get_function_identity_arguments(p.oid) =
      'p_type text, p_title text, p_description text, p_category text, p_event_date text, p_latitude double precision, p_longitude double precision, p_location_label text, p_youtube_url text, p_attachment_key text'
)
and exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_create_post_client_multi'
    and p.prosecdef = false and p.provolatile = 'v'
    and pg_get_function_identity_arguments(p.oid) =
      'p_type text, p_title text, p_description text, p_category text, p_event_date text, p_attachment_keys text[], p_latitude double precision, p_longitude double precision, p_location_label text, p_youtube_url text'
)
and exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_query_posts_client'
    and p.prosecdef = false and p.provolatile = 's'
    and pg_get_function_identity_arguments(p.oid) =
      'p_user_id text, p_type text, p_category text, p_status text, p_q text, p_date_from text, p_date_to text, p_cursor_created_at text, p_cursor_id text, p_order text, p_limit integer, p_post_id text'
)
and exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'findback_query_posts_nearby_client'
    and p.prosecdef = false and p.provolatile = 's'
    and pg_get_function_identity_arguments(p.oid) =
      'p_user_id text, p_type text, p_category text, p_status text, p_q text, p_date_from text, p_date_to text, p_cursor_created_at text, p_cursor_id text, p_order text, p_limit integer, p_near_lat double precision, p_near_lng double precision, p_radius_m double precision'
);
-- EXPECT: 1 row. create_or_replace preserves the oid, so a changed argument
-- list would already have failed the apply -- this pins it explicitly.

-- P11. Security surface untouched: same policy set, RLS still on, and no anon
-- or PUBLIC grant on either touched table.
select 'P11 policies, RLS and grants unchanged' as probe
where (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'attachments') = 2
  and (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'uploads') = 4
  and (select count(*) from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('attachments', 'uploads')
         and c.relrowsecurity) = 2
  and not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('attachments', 'uploads')
      and grantee in ('anon', 'PUBLIC')
  );
-- EXPECT: 1 row.

-- P12. create_or_replace preserved the function comments (the migration also
-- re-issued the revoke/grant/comment tails verbatim).
select 'P12 replaced functions kept their comments' as probe
where (
  select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('findback_create_post_client',
                      'findback_create_post_client_multi',
                      'findback_query_posts_client',
                      'findback_query_posts_nearby_client')
    and obj_description(p.oid, 'pg_proc') is not null
) = 4;
-- EXPECT: 1 row.

-- ---------------------------------------------------------------------------
-- 2. Live-run behavioral probes (disposable backend only; run-live.sh env)
-- ---------------------------------------------------------------------------
-- Setup (owner session): one staging row owned by TEST_USER_A in public.uploads
-- pointing at any small storage object A owns, plus a second staging row for the
-- multi path.
--
-- (a) Staged dimensions reach the published attachment. As TEST_USER_A_JWT:
--   PATCH "$TEST_SUPABASE_URL/rest/v1/uploads?id=eq.<UPLOAD_A_ID>" \
--     -d '{"width":1080,"height":1440}'
--   then POST "$TEST_SUPABASE_URL/rest/v1/rpc/findback_create_post_client_multi"
--     with {"p_type":"LOST","p_title":"dims probe","p_description":"",
--           "p_category":"OTHER","p_event_date":"","p_attachment_keys":["<UPLOAD_A_ID>"]}
--   then GET "$TEST_SUPABASE_URL/rest/v1/attachments?post_id=eq.<NEW_POST_ID>&select=width,height"
-- EXPECT: HTTP 200 and the attachment row reports width 1080 / height 1440.
--
-- (b) An out-of-range staged dimension is rejected at write time.
--   PATCH "$TEST_SUPABASE_URL/rest/v1/uploads?id=eq.<UPLOAD_A_ID>" -d '{"width":0}'
-- EXPECT: non-2xx with the check-constraint error (SQLSTATE 23514 /
-- uploads_dims_check). Restore the row afterwards.
--
-- (c) A client that sends no dimensions still publishes (backwards
-- compatibility for already-installed builds). Publish a post from a staging
-- row with width/height left NULL, then GET the attachment.
-- EXPECT: HTTP 200 and width/height null -- the feed must fall back to a
-- default ratio rather than refuse the post.
--
-- (d) Both consumer readers expose the keys. Call
-- findback_query_posts_client (and ..._nearby_client) for the post from (a).
-- EXPECT: the attachment jsonb objects carry "width"/"height" keys, non-null for
-- (a) and JSON null for legacy rows created before this migration.
