-- FindBack — Nearby discovery feed (UXN-1).
--
-- Additive ONLY: introduces `findback_query_posts_nearby_client` and touches
-- nothing else. `findback_query_posts_client` keeps its exact signature and
-- body, so every existing reader is unaffected.
--
-- Contract:
--   * Inputs mirror the client feed filters (user/type/category/status/q/
--     date range/keyset cursor/order/limit) plus:
--       p_near_lat / p_near_lng — already-rounded (~100 m) search center
--       p_radius_m              — search radius in meters
--   * Haversine (great-circle) filtering: only rows with numeric latitude AND
--     longitude can be proven nearby. Typed-location-only posts (coords null)
--     are excluded; the client tells the user in the sheet:
--     "Nearby uses reports with a map pin. Reports with only a typed place
--      name are not included."
--   * Keyset ordering is newest/oldest by created_at + id, identical to the
--     normal feed. Nearby filters by radius; it does NOT re-sort by distance,
--     and no distance is returned (no precise per-card distance, by design).
--   * total_count is the FULL proximity-filtered match count BEFORE the
--     keyset cursor is applied (same CTE/window pattern as the total
--     contract migration).
--   * SECURITY INVOKER, page size clamped to 20, authenticated-only.
--
-- The search center is private client session state: it is passed per call,
-- never persisted by this function, and never appears in shared URLs
-- (the client URL carries only `near=<radiusKm>`).

create or replace function public.findback_query_posts_nearby_client(
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
  total_count bigint
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
            'created_at', a.created_at
          ) order by a.created_at asc
        )
        from attachments a
        where a.post_id = p.id
      ), '[]'::jsonb) as attachments,
      count(*) over() as total_count
    from item_posts p
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
    total_count
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

revoke all on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) from public;
revoke all on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) from anon;
grant execute on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) to authenticated;

comment on function public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
) is 'FindBack nearby feed (authenticated): client feed filters plus Haversine radius scope (p_near_lat, p_near_lng, p_radius_m). Only map-pin rows qualify; total_count is the full proximity-filtered total before the keyset cursor. Never returns author email/phone or distance. Page size clamped to 20.';
