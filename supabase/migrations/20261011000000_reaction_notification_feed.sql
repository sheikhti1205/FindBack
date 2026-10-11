-- FindBack — W1-A: REACTION notifications + feed reaction truth + attachment order.
--
-- ADDITIVE / NON-DESTRUCTIVE. Never edits an applied migration; every object
-- below is created or replaced in this file only. No table/column drops, no
-- data deletion, no RLS policy changes.
--
-- FBX-009: canonical reaction kinds (LOVE/HELPFUL/SUPPORT/WOW) used to abort
--   the whole reaction write: the notification CHECK allowed only
--   LIKE/DISLIKE/COMMENT/MENTION/STATUS while the reaction trigger forwarded
--   NEW.type verbatim. This migration widens the notification CHECK with a
--   single REACTION kind, adds a nullable reaction_kind column carrying the
--   canonical kind, and repoints the trigger: LIKE/DISLIKE forward verbatim
--   (compat: existing rows, inbox copy, push preferences untouched), every
--   other kind forwards as REACTION + reaction_kind. Reaction switches stay
--   one current row across the legacy/canonical boundary (the supersede
--   delete now covers LIKE/DISLIKE/REACTION on active unread rows).
--   Self-reactions still notify nobody; read rows stay history.
--
-- FBX-010: both feed RPCs (normal + nearby) return canonical reaction_counts
--   (LIKE folded to LOVE, the single server-side fold), reaction_total, and
--   my_reaction (raw stored kind; the client normalizes for display).
--   like_count/dislike_count stay as compat-only columns.
--
-- FBX-011: both feed RPC attachment aggregates carry display_order and order
--   by it with deterministic ties (created_at, id).

-- ---------------------------------------------------------------------------
-- 1. FBX-009: widen notifications.type with REACTION (LIKE/DISLIKE kept).
--
-- The original constraint was declared inline, so its name is
-- Postgres-generated. Drop any existing CHECK on `notifications.type`
-- first (robust to the generated name), then re-add the widened one.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'notifications'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%type%'
  loop
    execute format('alter table public.notifications drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS', 'REACTION'));

-- Canonical kind carried by REACTION rows (LOVE/HELPFUL/SUPPORT/WOW).
-- NULL on every legacy row (LIKE/DISLIKE/COMMENT/MENTION/STATUS): absence
-- renders the generic reaction copy, never a wrong kind.
alter table public.notifications
  add column if not exists reaction_kind text;

-- ---------------------------------------------------------------------------
-- 2. FBX-009: insert helper learns the reaction kind (default keeps every
--    existing 6-argument caller working: comment + status triggers).
-- ---------------------------------------------------------------------------
drop function if exists
  public.findback_insert_notification(text, text, text, text, text, text);

create or replace function public.findback_insert_notification(
  p_user_id text,
  p_actor_id text,
  p_type text,
  p_post_id text,
  p_comment_id text,
  p_preview text,
  p_reaction_kind text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  -- Never notify yourself; never double-notify the same actor for the same
  -- post/comment/type. A NULL actor is allowed only for system STATUS rows.
  -- REACTION dedupes on (actor, post, REACTION) regardless of kind: the
  -- reaction trigger deletes the actor's superseded UNREAD reaction row
  -- before inserting, so switches keep one current row; read rows stay
  -- history and block re-notify, exactly like LIKE/DISLIKE before.
  if p_user_id is null or p_user_id = p_actor_id then
    return;
  end if;
  if p_actor_id is null and p_type <> 'STATUS' then
    return;
  end if;
  if p_comment_id is null then
    if exists (
      select 1 from public.notifications n
      where n.user_id = p_user_id
        and n.actor_id is not distinct from p_actor_id
        and n.type = p_type
        and n.post_id is not distinct from p_post_id
        and n.comment_id is null
        and n.deleted_at is null
    ) then
      return;
    end if;
  end if;
  insert into public.notifications
    (id, user_id, actor_id, type, post_id, comment_id, preview, read, created_at, deleted_at, reaction_kind)
  values
    (gen_random_uuid()::text, p_user_id, p_actor_id, p_type,
     p_post_id, p_comment_id, left(nullif(p_preview, ''), 200), 0, v_now, null, p_reaction_kind);
end;
$$;

revoke all on function
  public.findback_insert_notification(text, text, text, text, text, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. FBX-009: reaction trigger forwards canonical kinds as REACTION.
--
-- LIKE/DISLIKE forward verbatim (compat). LOVE/HELPFUL/SUPPORT/WOW forward
-- as REACTION with reaction_kind set, so every canonical kind commits with
-- exactly one owner notification instead of aborting the reaction write.
-- ---------------------------------------------------------------------------
create or replace function public.findback_notify_reaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text;
  v_title text;
  v_ntype text;
  v_rkind text;
begin
  select p.user_id, p.title into v_owner, v_title
  from public.item_posts p
  where p.id = new.post_id;
  if v_owner is null or v_owner = new.user_id then
    return new;
  end if;
  -- Reaction switch: drop the superseded UNREAD reaction row from the same
  -- actor on this post (legacy or canonical) so only the newest notifies.
  delete from public.notifications n
  where n.user_id = v_owner
    and n.actor_id = new.user_id
    and n.type in ('LIKE', 'DISLIKE', 'REACTION')
    and n.post_id = new.post_id
    and n.comment_id is null
    and n.read = 0
    and n.deleted_at is null;
  if new.type in ('LIKE', 'DISLIKE') then
    v_ntype := new.type;
    v_rkind := null;
  else
    v_ntype := 'REACTION';
    v_rkind := new.type;
  end if;
  perform public.findback_insert_notification(
    v_owner, new.user_id, v_ntype, new.post_id, null, v_title, v_rkind
  );
  return new;
end;
$$;

revoke all on function public.findback_notify_reaction() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. FBX-009: inbox RPC returns reaction_kind (drop + recreate: the return
--    shape grows one column; the p_deleted flag contract is unchanged).
-- ---------------------------------------------------------------------------
drop function if exists public.findback_list_notifications_client(boolean);

create or replace function public.findback_list_notifications_client(
  p_deleted boolean default false
)
returns table (
  id text,
  type text,
  preview text,
  read integer,
  created_at text,
  actor_id text,
  actor_username text,
  post_id text,
  post_title text,
  comment_id text,
  reaction_kind text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
    select
      n.id, n.type, n.preview, n.read, n.created_at,
      n.actor_id, u.username as actor_username,
      n.post_id, p.title as post_title,
      n.comment_id, n.reaction_kind
    from public.notifications n
    left join public.users u on u.id = n.actor_id
    left join public.item_posts p on p.id = n.post_id
    where n.user_id = v_uid
      and (
        (p_deleted and n.deleted_at is not null)
        or (not p_deleted and n.deleted_at is null)
      )
    order by
      case when p_deleted then n.deleted_at else n.created_at end desc,
      n.id desc
    limit 100;
end;
$$;

revoke all on function public.findback_list_notifications_client(boolean) from public, anon;
grant execute on function public.findback_list_notifications_client(boolean) to authenticated;

comment on function public.findback_list_notifications_client(boolean)
  is 'FindBack notification inbox (authenticated): caller-owned rows newest first; p_deleted selects the soft-deleted view. REACTION rows carry the canonical kind in reaction_kind (null on legacy rows). Max 100.';

-- ---------------------------------------------------------------------------
-- 5. FBX-010 + FBX-011: normal feed RPC returns canonical reaction truth
--    and display_order-ranked attachments (drop + recreate: return shape
--    grows reaction_counts/reaction_total/my_reaction + display_order).
--
-- Canonical fold (single server-side definition for the feed):
--   LIKE -> LOVE, every other kind counts as itself.
-- like_count/dislike_count keep their exact meaning as compat-only columns.
-- my_reaction is the raw stored kind (the client normalizes LIKE to LOVE
-- for display); the reactions SELECT policy lets this SECURITY INVOKER
-- function see every row while the wire still exposes only the caller's own.
-- ---------------------------------------------------------------------------
drop function if exists public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
);

create or replace function public.findback_query_posts_client(
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
  p_post_id text default null
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
  my_reaction text
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
            'display_order', a.display_order
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
    from item_posts p
    join users u on u.id = p.user_id
    where
      (p_post_id is null or p.id = p_post_id)
      and (p_user_id is null or p.user_id = p_user_id)
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
    my_reaction
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

revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from public;
revoke all on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) from anon;
grant execute on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) to authenticated;

comment on function public.findback_query_posts_client(
  text, text, text, text, text, text, text, text, text, text, integer, text
) is 'FindBack client feed/listing (authenticated): post + public author + aggregates + display_order-ranked attachments with keyset pagination, exact post lookup and total_count window. reaction_counts/reaction_total/my_reaction are the canonical reaction truth (LIKE folded to LOVE); like_count/dislike_count remain as compat. Never returns author email/phone. Page size clamped to 20.';

-- ---------------------------------------------------------------------------
-- 6. FBX-010 + FBX-011: nearby feed RPC, same reaction truth + ordering.
-- ---------------------------------------------------------------------------
drop function if exists public.findback_query_posts_nearby_client(
  text, text, text, text, text, text, text, text, text, text, integer,
  double precision, double precision, double precision
);

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
  total_count bigint,
  reaction_counts jsonb,
  reaction_total bigint,
  my_reaction text
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
            'display_order', a.display_order
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
    total_count,
    reaction_counts,
    reaction_total,
    my_reaction
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
) is 'FindBack nearby feed (authenticated): client feed filters plus Haversine radius scope (p_near_lat, p_near_lng, p_radius_m). Only map-pin rows qualify; total_count is the full proximity-filtered total before the keyset cursor. reaction_counts/reaction_total/my_reaction are the canonical reaction truth (LIKE folded to LOVE); like_count/dislike_count remain as compat. Attachments are display_order-ranked. Never returns author email/phone or distance. Page size clamped to 20.';
