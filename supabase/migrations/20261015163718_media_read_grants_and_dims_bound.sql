-- FindBack - uploaded-media read grants + a dims bound that cannot block a publish
-- (CF-060 M1 repair, from the independent REVIEW-M1 of 20261015154642).
--
-- Two defects in 20261015154642, both found by review and both closed here.
--
-- 1. GRANT COVERAGE (REVIEW-M1 F1/F2). That migration added columns to two
--    tables whose `authenticated` SELECT is granted column-by-column
--    (20260914190000_post_mutations.sql:26-27 for uploads,
--    20260914180000_client_post_reads.sql:62-64 for attachments) without
--    extending those grants. A column list does not cover a column added later,
--    so in an environment built from this repo's migrations:
--      * `select * into v_upload` in BOTH publish RPCs expands to 9 columns
--        against 7 granted and raises 42501 - every photo report fails to
--        publish, for new and already-installed clients alike;
--      * both consumer readers (`findback_query_posts_client`,
--        `findback_query_posts_nearby_client`) fail on 'width'/'height', so the
--        dimensions this change exists to carry could never reach the feed.
--    `display_order` (added by 20260926000000) was never granted either - the
--    same class, one migration older.
--
--    Live state, verified before writing this file (information_schema
--    .table_privileges plus a behavioural probe as role `authenticated`): the
--    hosted project holds a TABLE-level SELECT for `authenticated` on both
--    tables, so every column is already readable there and production is not
--    broken. That is why this is a repair of the repository, not an incident.
--    The repo is what rebuilds an environment, and it must not depend on a
--    grant that exists only in a dashboard-created project. The explicit column
--    lists below are exactly the union of the columns each table has, so the
--    repo model and the hosted model agree from this migration forward, and
--    nothing is widened relative to production.
--
-- 2. DIMS BOUND (REVIEW-M1 F4). The 1..8192 ceiling on the dims checks was
--    tighter than the media pipeline. Animated GIFs are passed through untouched
--    (apps/mobile/src/services/image.ts) and are only refused above 30M decoded
--    pixels, so a 9000x3000 GIF is publishable and hit SQLSTATE 23514 at
--    staging, surfacing the raw Postgres sentence to the user. These columns are
--    a display hint; they must never decide what a user is allowed to publish.
--    The bound is widened to a sanity ceiling the pipeline cannot reach, and the
--    client now stores NULL rather than a value it cannot vouch for.
--
-- ADDITIVE ONLY. No column is added, dropped or retyped; no row is rewritten;
-- no function signature, body, security mode or volatility changes; no RLS
-- policy is created, dropped or altered. The two dims checks are re-created with
-- their existing names and stay NOT VALID, so legacy NULL rows are never
-- rescanned. Client-visible behaviour changes only in that previously failing
-- reads and previously rejected dimension values now succeed.
--
-- LIVE-PENDING: post-apply behaviour is verified by
-- supabase/tests/verify_20261015163718_media_read_grants.sql, which (unlike
-- 20261015154642's catalog-only probes) executes the reads as role
-- `authenticated`. Statically guarded by the column-grant coverage check in
-- supabase/tests/migration_parity.test.mjs.

-- ---------------------------------------------------------------------------
-- 1. `authenticated` must be able to read every column of both media tables
--
-- Column lists, not `grant select on table`: the repo's least-privilege pattern
-- is kept, and the list is exhaustive for each table (uploads: 9 columns,
-- attachments: 10), so `select *` in the publish RPCs is satisfied. A future
-- column added to either table must extend the list in the migration that adds
-- it - the parity guard fails the build otherwise.
-- ---------------------------------------------------------------------------
grant select (
  id, user_id, file_name, mime_type, file_size, file_url, created_at, width, height
) on public.uploads to authenticated;

grant select (
  id, post_id, file_url, mime_type, file_name, file_size, created_at,
  display_order, width, height
) on public.attachments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A display hint may never reject a publishable image
--
-- 1..100000 CSS pixels. The client refuses animated GIFs above 30M decoded
-- pixels and downsamples every other still to a 1920px longest edge, so no real
-- pipeline output comes near this ceiling; it exists only to reject garbage
-- written by a non-client writer. Mirrored in the client by
-- MAX_DISPLAY_DIMENSION (apps/mobile/src/services/media/displayDimensions.ts).
-- ---------------------------------------------------------------------------
alter table public.attachments drop constraint if exists attachments_dims_check;
alter table public.attachments
  add constraint attachments_dims_check check (
    (width is null or (width >= 1 and width <= 100000))
    and (height is null or (height >= 1 and height <= 100000))
  ) not valid;

alter table public.uploads drop constraint if exists uploads_dims_check;
alter table public.uploads
  add constraint uploads_dims_check check (
    (width is null or (width >= 1 and width <= 100000))
    and (height is null or (height >= 1 and height <= 100000))
  ) not valid;

comment on column public.uploads.width is
  'Intrinsic width of the stored blob, in CSS pixels. A display hint (NULL = unknown); never a constraint on what may be published.';
comment on column public.uploads.height is
  'Intrinsic height of the stored blob, in CSS pixels. A display hint (NULL = unknown); never a constraint on what may be published.';
comment on column public.attachments.width is
  'Intrinsic width of the report photo, in CSS pixels. A display hint (NULL = unknown / pre-20261015154642 row).';
comment on column public.attachments.height is
  'Intrinsic height of the report photo, in CSS pixels. A display hint (NULL = unknown / pre-20261015154642 row).';
