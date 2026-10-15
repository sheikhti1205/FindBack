-- FindBack - attachment display dimensions end-to-end (CF-060 M1 / IF-101).
--
-- Problem: the feed cannot lay out a natural-ratio / masonry grid because
-- public.attachments (report photos) carries no display dimensions. The comment
-- path already solved this: public.comment_attachments carries nullable
-- width/height plus a bounded dims check. This migration mirrors that proven
-- convention onto the report path instead of inventing a parallel one.
--
-- Shape:
--   * public.uploads     + width/height - the staging row the client already
--     writes after client-side normalization (normalizeImage returns
--     {width,height}), so the publish RPC can carry the values across;
--   * public.attachments + width/height - the durable row the feed reads;
--   * both bounded 1..8192 exactly like comment_attachments_dims_check, NULL
--     allowed for every legacy row. Nothing is backfilled: no production image
--     is fetched just to fill a column, and legacy rows keep rendering through
--     the client's ratio fallback;
--   * both create RPCs (findback_create_post_client and
--     findback_create_post_client_multi) copy the staging dimensions into the
--     attachment row, so the single-key and multi-key publish paths cannot
--     diverge;
--   * both consumer readers (findback_query_posts_client,
--     findback_query_posts_nearby_client) return the two keys inside the
--     existing attachment jsonb.
--
-- ADDITIVE ONLY. No column is dropped or retyped, no row is rewritten, no
-- function signature changes, and no RLS policy or grant changes: the three
-- touched tables keep their current authenticated-only DML grants and policies.
-- An already-installed client keeps working and simply receives two extra jsonb
-- keys it may ignore.
--
-- findback_query_posts (the legacy non-client reader used by services/api) is
-- deliberately NOT redefined: it is not on the consumer feed path, so leaving it
-- untouched keeps this change's blast radius to the two readers the app calls.
-- Adding the same keys there is an additive follow-up if the API ever needs it.
--
-- LIVE-PENDING: post-apply behaviour is verified by
-- supabase/tests/verify_20261015154642_attachment_dimensions.sql. Before apply
-- the whole file is exercised by a transactional dry-run (begin/rollback)
-- against the live project plus the static asserts in
-- supabase/tests/migration_parity.test.mjs.

-- ---------------------------------------------------------------------------
-- 1. Display dimensions on the staging and durable media rows
-- ---------------------------------------------------------------------------
alter table public.uploads
  add column if not exists width integer;

alter table public.uploads
  add column if not exists height integer;

alter table public.attachments
  add column if not exists width integer;

alter table public.attachments
  add column if not exists height integer;

-- ---------------------------------------------------------------------------
-- 2. Bounded dims checks (same expression + name shape as the comment path)
--
-- Kept NOT VALID on purpose, matching comment_attachments_dims_check: the
-- constraint governs every new insert/update while existing rows (all NULL
-- here) are never re-scanned by a validation pass.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'attachments_dims_check'
  ) then
    alter table public.attachments
      add constraint attachments_dims_check check (
        (width is null or (width >= 1 and width <= 8192))
        and (height is null or (height >= 1 and height <= 8192))
      ) not valid;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'uploads_dims_check'
  ) then
    alter table public.uploads
      add constraint uploads_dims_check check (
        (width is null or (width >= 1 and width <= 8192))
        and (height is null or (height >= 1 and height <= 8192))
      ) not valid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Write path: publish copies the staging dimensions onto the attachment
--
-- create or replace preserves each function's oid, so the existing
-- revoke/grant tail and function comment are preserved; they are re-issued
-- below verbatim so this file remains self-describing and the signature is
-- re-proven against the grants.
-- ---------------------------------------------------------------------------
-- findback_create_post_client
create or replace function public.findback_create_post_client(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null,
  p_attachment_key text default null
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id  text;
  v_now text;
  v_upload record;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  perform public.findback_validate_post_fields(
    p_type, p_title, p_description, p_category, p_event_date,
    p_latitude, p_longitude, p_location_label, p_youtube_url
  );

  v_id := gen_random_uuid()::text;
  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.item_posts (
    id, user_id, type, title, description, category, status, event_date,
    latitude, longitude, location_label, youtube_url, created_at, updated_at
  ) values (
    v_id, v_uid, p_type, btrim(p_title), btrim(p_description), p_category, 'OPEN',
    p_event_date, p_latitude, p_longitude,
    nullif(btrim(coalesce(p_location_label, '')), ''),
    nullif(btrim(coalesce(p_youtube_url, '')), ''),
    v_now, v_now
  );

  if p_attachment_key is not null and btrim(p_attachment_key) <> '' then
    select * into v_upload
      from public.uploads
     where id = p_attachment_key
       for update;
    if not found then
      raise exception 'Attachment key does not exist' using errcode = '22023';
    end if;
    if v_upload.user_id <> v_uid then
      raise exception 'Attachment was not uploaded by you' using errcode = '42501';
    end if;
    insert into public.attachments (
      id, post_id, file_url, mime_type, file_name, file_size, created_at,
      width, height
    ) values (
      gen_random_uuid()::text, v_id, v_upload.file_url, v_upload.mime_type,
      v_upload.file_name, v_upload.file_size, v_now,
      v_upload.width, v_upload.height
    );
    delete from public.uploads
     where id = p_attachment_key and user_id = v_uid;
  end if;

  return v_id;
end;
$$;


revoke all on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) from public, anon;

grant execute on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) to authenticated;

comment on function public.findback_create_post_client(
  text, text, text, text, text, double precision, double precision, text, text, text
) is 'FindBack create post (authenticated): owner is auth.uid(); returns the new post id. Optional staging upload must belong to the caller and is consumed in the same transaction.';

-- findback_create_post_client_multi
create or replace function public.findback_create_post_client_multi(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_attachment_keys text[] default '{}',
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_id  text;
  v_now text;
  v_keys text[] := coalesce(p_attachment_keys, '{}');
  v_key text;
  v_pos integer := 0;
  v_upload record;
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if array_length(v_keys, 1) > 5 then
    raise exception 'At most 5 attachments are allowed' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_keys) as k
     group by k having count(*) > 1
  ) then
    raise exception 'Duplicate attachment keys are not allowed' using errcode = '22023';
  end if;

  foreach v_key in array v_keys loop
    if v_key is null or btrim(v_key) = '' then
      raise exception 'Attachment key must not be empty' using errcode = '22023';
    end if;
  end loop;

  perform public.findback_validate_post_fields(
    p_type, p_title, p_description, p_category, p_event_date,
    p_latitude, p_longitude, p_location_label, p_youtube_url
  );

  v_id := gen_random_uuid()::text;
  v_now := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  insert into public.item_posts (
    id, user_id, type, title, description, category, status, event_date,
    latitude, longitude, location_label, youtube_url, created_at, updated_at
  ) values (
    v_id, v_uid, p_type, btrim(p_title), btrim(p_description), p_category, 'OPEN',
    p_event_date, p_latitude, p_longitude,
    nullif(btrim(coalesce(p_location_label, '')), ''),
    nullif(btrim(coalesce(p_youtube_url, '')), ''),
    v_now, v_now
  );

  if cardinality(v_keys) > 0 then
    -- Take row locks in deterministic key order first, so concurrent
    -- publishers cannot deadlock each other. The existing uploads UPDATE
    -- lock grant and policy already permit this lock.
    perform 1
      from public.uploads
     where id = any (v_keys)
     order by id
     for update;

    foreach v_key in array v_keys loop
      select * into v_upload
        from public.uploads
       where id = v_key;
      if not found then
        raise exception 'Attachment key does not exist' using errcode = '22023';
      end if;
      if v_upload.user_id <> v_uid then
        raise exception 'Attachment was not uploaded by you' using errcode = '42501';
      end if;
      v_pos := v_pos + 1;
      insert into public.attachments (
        id, post_id, file_url, mime_type, file_name, file_size, created_at, display_order,
        width, height
      ) values (
        gen_random_uuid()::text, v_id, v_upload.file_url, v_upload.mime_type,
        v_upload.file_name, v_upload.file_size, v_now, v_pos,
        v_upload.width, v_upload.height
      );
    end loop;

    delete from public.uploads
     where id = any (v_keys) and user_id = v_uid;
    get diagnostics v_deleted = row_count;
    if v_deleted <> cardinality(v_keys) then
      raise exception 'Staging uploads changed during publish' using errcode = '40001';
    end if;
  end if;

  return v_id;
end;
$$;


revoke all on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) from public, anon;

grant execute on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) to authenticated;

comment on function public.findback_create_post_client_multi(
  text, text, text, text, text, text[], double precision, double precision, text, text
) is 'FindBack create post with 0-5 ordered attachments (authenticated): owner is auth.uid(); returns the new post id. Each staging upload must belong to the caller and is consumed in the same transaction.';

-- ---------------------------------------------------------------------------
-- 4. Read path: the consumer feed attachments jsonb carries the dimensions
-- ---------------------------------------------------------------------------
-- findback_query_posts_client
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

-- findback_query_posts_nearby_client
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

