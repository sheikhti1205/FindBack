-- FindBack — backend-only RPCs for the two operations that PostgREST table
-- queries cannot express cleanly:
--   * findback_query_posts — feed/listing with per-post aggregates + total_count
--   * findback_report      — activity reporting bundle
--
-- Security: these are backend-only. They run as SECURITY INVOKER (the caller's
-- privileges apply) and EXECUTE is granted ONLY to service_role. The Node API
-- is the sole intended caller (via SUPABASE_SECRET_KEY). PUBLIC/anon/
-- authenticated cannot execute them, so they are not reachable from the Data
-- API with a publishable key.

-- ---------------------------------------------------------------------------
-- Feed / listing
-- ---------------------------------------------------------------------------
-- Mirrors SqliteStore.queryPosts/countPosts:
--   * filters: user, type, category, status, text search, event date range
--   * keyset pagination over (created_at, id) honouring sort direction
--   * author fields, LIKE/DISLIKE/rating/comment aggregates and attachments
--   * `total_count` is a window count over the fully filtered set, so the same
--     RPC serves both queryPosts (rows) and countPosts (total only).
create or replace function public.findback_query_posts(
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
  p_limit integer default 10
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
  author_email text,
  author_phone text,
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
  select
    p.*,
    u.username as author_username,
    u.email as author_email,
    u.phone as author_phone,
    u.email_verified as author_email_verified,
    u.phone_verified as author_phone_verified,
    u.avatar_url as author_avatar_url,
    u.created_at as author_created_at,
    (select count(*) from reactions r where r.post_id = p.id and r.type = 'LIKE') as like_count,
    (select count(*) from reactions r where r.post_id = p.id and r.type = 'DISLIKE') as dislike_count,
    (select avg(score) from ratings ra where ra.post_id = p.id) as rating_avg,
    (select count(*) from ratings ra where ra.post_id = p.id) as rating_count,
    (select count(*) from comments c where c.post_id = p.id) as comment_count,
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
    and (
      p_cursor_created_at is null
      or (
        p_order = 'asc'
        and (
          p.created_at > p_cursor_created_at
          or (p.created_at = p_cursor_created_at and p.id > coalesce(p_cursor_id, ''))
        )
      )
      or (
        p_order <> 'asc'
        and (
          p.created_at < p_cursor_created_at
          or (p.created_at = p_cursor_created_at and p.id < coalesce(p_cursor_id, ''))
        )
      )
    )
  order by
    (case when p_order = 'asc' then p.created_at end) asc,
    (case when p_order = 'asc' then p.id end) asc,
    (case when p_order <> 'asc' then p.created_at end) desc,
    (case when p_order <> 'asc' then p.id end) desc
  limit greatest(p_limit, 0);
$$;

-- ---------------------------------------------------------------------------
-- Reporting bundle
-- ---------------------------------------------------------------------------
-- Returns one JSONB document with everything the reporting Store methods need:
-- summary, byDay, byType, byStatus, byCategory, topContributors.
create or replace function public.findback_report(
  p_days integer default 14,
  p_top_limit integer default 8
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'totalPosts', (select count(*) from item_posts),
      'openPosts', (select count(*) from item_posts where status = 'OPEN'),
      'recoveredPosts', (select count(*) from item_posts where status = 'RECOVERED'),
      'matchedPosts', (select count(*) from item_posts where status = 'MATCHED'),
      'closedPosts', (select count(*) from item_posts where status = 'CLOSED'),
      'lostPosts', (select count(*) from item_posts where type = 'LOST'),
      'foundPosts', (select count(*) from item_posts where type = 'FOUND'),
      'totalUsers', (select count(*) from users),
      'totalComments', (select count(*) from comments),
      'totalReactions', (select count(*) from reactions),
      'totalRatings', (select count(*) from ratings),
      'averageRating', (select avg(score) from ratings),
      'postsLast7Days', (
        select count(*) from item_posts
        where created_at::timestamptz >= now() - interval '7 days'
      )
    ),
    'byDay', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'date', to_char(d, 'YYYY-MM-DD'),
          'posts', (select count(*) from item_posts where created_at::timestamptz::date = d::date),
          'comments', (select count(*) from comments where created_at::timestamptz::date = d::date),
          'newUsers', (select count(*) from users where created_at::timestamptz::date = d::date)
        ) order by d
      ), '[]'::jsonb)
      from generate_series(
        current_date - greatest(p_days, 0),
        current_date,
        interval '1 day'
      ) as d
    ),
    'byType', (
      select coalesce(jsonb_agg(
        jsonb_build_object('value', type, 'count', cnt) order by cnt desc
      ), '[]'::jsonb)
      from (select type, count(*) as cnt from item_posts group by type) t
    ),
    'byStatus', (
      select coalesce(jsonb_agg(
        jsonb_build_object('value', status, 'count', cnt) order by cnt desc
      ), '[]'::jsonb)
      from (select status, count(*) as cnt from item_posts group by status) t
    ),
    'byCategory', (
      select coalesce(jsonb_agg(
        jsonb_build_object('value', category, 'count', cnt) order by cnt desc
      ), '[]'::jsonb)
      from (select category, count(*) as cnt from item_posts group by category) t
    ),
    'topContributors', (
      select coalesce(jsonb_agg(
        jsonb_build_object('username', username, 'posts', posts, 'comments', comments)
        order by (posts + comments) desc, posts desc
      ), '[]'::jsonb)
      from (
        select u.username,
               count(distinct p.id) as posts,
               count(distinct c.id) as comments
        from users u
        left join item_posts p on p.user_id = u.id
        left join comments c on c.user_id = u.id
        group by u.id, u.username
        order by (count(distinct p.id) + count(distinct c.id)) desc,
                 count(distinct p.id) desc
        limit greatest(p_top_limit, 0)
      ) t
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Grants: backend-only (service_role). Never reachable with anon/authenticated.
-- ---------------------------------------------------------------------------
revoke all on function public.findback_query_posts(
  text, text, text, text, text, text, text, text, text, text, integer
) from public;
revoke all on function public.findback_query_posts(
  text, text, text, text, text, text, text, text, text, text, integer
) from anon;
revoke all on function public.findback_query_posts(
  text, text, text, text, text, text, text, text, text, text, integer
) from authenticated;
grant execute on function public.findback_query_posts(
  text, text, text, text, text, text, text, text, text, text, integer
) to service_role;

revoke all on function public.findback_report(integer, integer) from public;
revoke all on function public.findback_report(integer, integer) from anon;
revoke all on function public.findback_report(integer, integer) from authenticated;
grant execute on function public.findback_report(integer, integer) to service_role;

comment on function public.findback_query_posts(
  text, text, text, text, text, text, text, text, text, text, integer
) is 'FindBack feed/listing: post + author + aggregates + attachments with keyset pagination and total_count window. Backend-only (service_role).';
comment on function public.findback_report(integer, integer)
  is 'FindBack reporting bundle (summary, byDay, grouped counts, top contributors) as JSONB. Backend-only (service_role).';
