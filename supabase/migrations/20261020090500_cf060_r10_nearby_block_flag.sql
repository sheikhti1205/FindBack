-- ===========================================================================
-- CF-060 Residual 10 (2/2: nearby reader) — public.findback_query_posts_nearby_client
-- ===========================================================================
-- The two feed readers deliberately did NOT project the O5 block bit that B1's
-- public.findback_visible_posts view already exposes (draft-b1/README.md
-- Residual 10, :357-365). This migration closes that gap for ONE reader.
--
-- Shape policy (design §2.2): the body is the applied B1 text with exactly two
-- deltas — `blocked_author boolean` appended LAST in RETURNS TABLE, and
-- `blocked_author` appended LAST in the outer projection. The value already
-- exists inside the `filtered` CTE (`select p.*` from the view), so the reader
-- re-derives NO predicate and adds NO block term of its own: in particular it
-- never reads public.user_blocks and never calls the block helpers.
--
-- The row set, row order, page clamp (least(greatest(p_limit,0),20)), every
-- pre-existing column and every filter are unchanged: O5 requires the row to be
-- PRESENT and flagged, never hidden (MODERATION-CONTRACT-DECISION §13.8 item 3).
--
-- PostgreSQL cannot add an OUT column with `create or replace`, so the function
-- is dropped and re-created. A DROP discards the ACL, so the revokes, the
-- authenticated grant and the comment are re-issued in the same transaction.
-- The explicit begin/commit is part of the file because a half-applied drop is
-- an outage for every surface that reads this reader (design §2.3).
--
-- Additive on the wire (PostgREST returns rows keyed by column name) and
-- requires no new grant: the view's whole-row SELECT to authenticated already
-- covers the new output, and findback_is_blocked_with_me (called by the view)
-- is already granted. anon gains nothing.
--
-- Verification: supabase/tests/verify_20261020090500_cf060_r10_feed_block_flag.sql
-- (engine stanzas; hosted execution UNRUN — see that file's header).
--
-- APPLIED (parse + behaviour proof): 2026-10-20, disposable local PostgreSQL 17
-- cluster, THIS worktree's own supabase/migrations chain
-- (FB_SRC=<R10>/supabase, FB_CLUSTER_ROOT=/home/sheikh/fb-work/pgx/clusters):
-- APPLIED 63/63 migrations, FAILED 0. Behaviour probe: F2/F3/F8/F9/F10 PASS.
-- Log: rendered-evidence-r10/logs/engine-apply-and-probe.log.
-- Parse-level guard: supabase/tests/migration_sql_syntax.test.mjs.

begin;

drop function if exists public.findback_query_posts_nearby_client(text, text, text, text, text, text, text, text, text, text, integer, double precision, double precision, double precision);

create function public.findback_query_posts_nearby_client(
  p_user_id text default null,
  p_type text default null,
  p_category text default null,
  p_status text default null,
  p_q text default null,
  p_date_from text default null,
  p_date_to text default null,
  p_cursor_created_at text default null,
  p_cursor_id text default null,
  p_order text default 'desc',
  p_limit integer default 10,
  p_near_lat double precision default null,
  p_near_lng double precision default null,
  p_radius_m double precision default null
)
returns table (
  id text,
  user_id text,
  type text,
  title text,
  description text,
  category text,
  status text,
  event_date text,
  latitude double precision,
  longitude double precision,
  location_label text,
  youtube_url text,
  created_at text,
  updated_at text,
  author_username text,
  author_email_verified integer,
  author_phone_verified integer,
  author_avatar_url text,
  author_created_at text,
  like_count bigint,
  dislike_count bigint,
  rating_avg numeric,
  rating_count bigint,
  comment_count bigint,
  attachments jsonb,
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text,
  blocked_author boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with filtered as (
    select
      p.*,
      u.username as author_username,
      u.email_verified as author_email_verified,
      u.phone_verified as author_phone_verified,
      u.avatar_url as author_avatar_url,
      u.created_at as author_created_at,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
      (select count(r.id) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
      (select avg(ra.score) from ratings ra where ra.post_id = p.id) as rating_avg,
      (select count(ra.id) from ratings ra where ra.post_id = p.id) as rating_count,
      (select count(c.id) from comments c where c.post_id = p.id) as comment_count,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'post_id', a.post_id,
            'file_url', a.file_url,
            'mime_type', a.mime_type,
            'file_name', a.file_name,
            'file_size', a.file_size,
            'created_at', a.created_at,
            'display_order', a.display_order,
            'width', a.width,
            'height', a.height
          ) order by a.display_order asc, a.created_at asc, a.id asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count,
      coalesce((
        select jsonb_object_agg(t.kind, t.n)
        from (
          select case when r.type = 'LIKE' then 'LOVE' else r.type end as kind,
                 count(*) as n
          from public.reactions r
          where r.post_id = p.id
          group by 1
        ) t
      ), '{}'::jsonb) as reaction_counts,
      (select count(r.id) from reactions r where r.post_id = p.id) as reaction_total,
      (select r.type from reactions r
        where r.post_id = p.id and r.user_id = auth.uid()::text
        limit 1) as my_reaction
    from public.findback_visible_posts p
    join users u on u.id = p.user_id
    where
      (p_user_id is null or p.user_id = p_user_id)
      and (p_type is null or p.type = p_type)
      and (p_category is null or p.category = p_category)
      and (p_status is null or p.status = p_status)
      and (
        p_q is null
        or lower(p.title) like '%' || lower(p_q) || '%'
        or lower(p.description) like '%' || lower(p_q) || '%'
      )
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
      -- Only rows with numeric coordinates can be proven nearby; typed-only
      -- posts are excluded from this scope by design.
      and p.latitude is not null
      and p.longitude is not null
      and (
        p_near_lat is null
        or p_near_lng is null
        or p_radius_m is null
        or (
          6371000 * 2 * asin(sqrt(least(1, greatest(0,
            power(sin(radians(p.latitude - p_near_lat) / 2), 2)
            + cos(radians(p_near_lat)) * cos(radians(p.latitude))
              * power(sin(radians(p.longitude - p_near_lng) / 2), 2)
          )))) <= p_radius_m
        )
      )
  )
  select
    id,
    user_id,
    type,
    title,
    description,
    category,
    status,
    event_date,
    latitude,
    longitude,
    location_label,
    youtube_url,
    created_at,
    updated_at,
    author_username,
    author_email_verified,
    author_phone_verified,
    author_avatar_url,
    author_created_at,
    like_count,
    dislike_count,
    rating_avg,
    rating_count,
    comment_count,
    attachments,
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction,
    blocked_author
  from filtered
  where
    p_cursor_created_at is null
    or (
      p_order = 'asc'
      and (
        created_at > p_cursor_created_at
        or (created_at = p_cursor_created_at and id > coalesce(p_cursor_id, ''))
      )
    )
    or (
      p_order <> 'asc'
      and (
        created_at < p_cursor_created_at
        or (created_at = p_cursor_created_at and id < coalesce(p_cursor_id, ''))
      )
    )
  order by
    (case when p_order = 'asc' then created_at end) asc,
    (case when p_order = 'asc' then id end) asc,
    (case when p_order <> 'asc' then created_at end) desc,
    (case when p_order <> 'asc' then id end) desc
  limit least(greatest(p_limit, 0), 20);
$$;

revoke all on function public.findback_query_posts_nearby_client(  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision) from public;

revoke all on function public.findback_query_posts_nearby_client(  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision) from anon;

grant execute on function public.findback_query_posts_nearby_client(  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision) to authenticated;

comment on function public.findback_query_posts_nearby_client(  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision)
  is $cmt$FindBack nearby feed (authenticated): client feed filters plus Haversine radius scope (p_near_lat, p_near_lng, p_radius_m). Only map-pin rows qualify; total_count is the full proximity-filtered total before the keyset cursor. reaction_counts/reaction_total/my_reaction are the canonical reaction truth (LIKE folded to LOVE); like_count/dislike_count remain as compat. Attachments are display_order-ranked. Never returns author email/phone or distance. Page size clamped to 20. blocked_author is the caller-scoped, direction-free O5 signal (true when a block relationship exists between the caller and this row's author); it is projected LAST and never filters a row.$cmt$;

commit;
