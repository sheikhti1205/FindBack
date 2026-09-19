-- FindBack — validation alignment for create/update (W6 #17, #16).
--
-- This migration tightens server-side validation to match the client:
-- 1. event_date: strict YYYY-MM-DD + valid calendar date + not future.
-- 2. youtube_url: null/empty allowed; else must be a supported YouTube host/format.
-- 3. UPDATE validates the MERGED row (coalesced new + existing), not just provided fields.

-- ---------------------------------------------------------------------------
-- Helper: strict YouTube URL check (matches client extractYouTubeId logic).
-- Accepts: youtube.com/watch?v=, youtube.com/embed/, youtube.com/shorts/, youtu.be/
-- Rejects: arbitrary https, vimeo, etc.
-- ---------------------------------------------------------------------------
create or replace function public.findback_is_valid_youtube_url(p_url text)
returns boolean
language sql
security invoker
set search_path = public, pg_temp
as $$
  select
    p_url is not null
    and btrim(p_url) <> ''
    and p_url ~* '^https?://(www\.)?(youtube\.com/(watch\?v=|embed/|shorts/)|youtu\.be/)[\w-]{11}';
$$;

-- ---------------------------------------------------------------------------
-- Helper: strict calendar date check (YYYY-MM-DD, valid day for month/year).
-- ---------------------------------------------------------------------------
create or replace function public.findback_is_valid_calendar_date(p_date text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_year  int;
  v_month int;
  v_day   int;
  v_dt    date;
begin
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  v_year  := p_date[1:4]::int;
  v_month := p_date[6:7]::int;
  v_day   := p_date[9:10]::int;
  begin
    v_dt := make_date(v_year, v_month, v_day);
    -- make_date validates day/month/year; if it succeeds, the date is valid.
    return true;
  exception when others then
    return false;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Replace the shared validation function with stricter checks.
-- ---------------------------------------------------------------------------
create or replace function public.findback_validate_post_fields(
  p_type text,
  p_title text,
  p_description text,
  p_category text,
  p_event_date text,
  p_latitude double precision,
  p_longitude double precision,
  p_location_label text,
  p_youtube_url text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_type is null or p_type not in ('LOST', 'FOUND') then
    raise exception 'Invalid post type' using errcode = '22023';
  end if;
  if p_title is null or char_length(btrim(p_title)) < 3
     or char_length(btrim(p_title)) > 120 then
    raise exception 'Title must be 3-120 characters' using errcode = '22023';
  end if;
  if p_description is null or char_length(btrim(p_description)) < 10
     or char_length(btrim(p_description)) > 3000 then
    raise exception 'Description must be 10-3000 characters' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'Electronics', 'Bags & Wallets', 'Keys', 'Documents & IDs',
    'Books & Stationery', 'Clothing', 'Accessories & Jewelry', 'Other'
  ) then
    raise exception 'Invalid category' using errcode = '22023';
  end if;
  -- event_date: strict YYYY-MM-DD + valid calendar date + not future
  if p_event_date is null or btrim(p_event_date) = ''
     or not public.findback_is_valid_calendar_date(p_event_date) then
    raise exception 'A valid date is required' using errcode = '22023';
  end if;
  if p_event_date::date > (now() at time zone 'utc')::date then
    raise exception 'The date can''t be in the future' using errcode = '22023';
  end if;
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'Invalid latitude' using errcode = '22023';
  end if;
  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'Invalid longitude' using errcode = '22023';
  end if;
  if p_location_label is not null and char_length(p_location_label) > 200 then
    raise exception 'Location label is too long' using errcode = '22023';
  end if;
  -- youtube_url: null/empty allowed; else must be valid YouTube URL
  if p_youtube_url is not null and btrim(p_youtube_url) <> ''
     and not public.findback_is_valid_youtube_url(p_youtube_url) then
    raise exception 'YouTube URL must be a valid YouTube link' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.findback_validate_post_fields(
  text, text, text, text, text, double precision, double precision, text, text
) from public, anon;
grant execute on function public.findback_validate_post_fields(
  text, text, text, text, text, double precision, double precision, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Update the UPDATE function to validate the MERGED row (coalesced new + existing).
-- ---------------------------------------------------------------------------
create or replace function public.findback_update_post_client(
  p_post_id text,
  p_type text default null,
  p_title text default null,
  p_description text default null,
  p_category text default null,
  p_event_date text default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_location_label text default null,
  p_youtube_url text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_count integer;
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_existing record;
  v_merged_type text;
  v_merged_title text;
  v_merged_description text;
  v_merged_category text;
  v_merged_event_date text;
  v_merged_latitude double precision;
  v_merged_longitude double precision;
  v_merged_location_label text;
  v_merged_youtube_url text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Fetch existing row to build the merged values for validation
  select type, title, description, category, event_date, latitude, longitude, location_label, youtube_url
    into v_existing
    from public.item_posts
   where id = p_post_id and user_id = v_uid;

  if not found then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;

  -- Build merged values (new value if provided, else existing)
  v_merged_type           := coalesce(p_type, v_existing.type);
  v_merged_title          := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_existing.title);
  v_merged_description    := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_existing.description);
  v_merged_category       := coalesce(p_category, v_existing.category);
  v_merged_event_date     := coalesce(nullif(btrim(coalesce(p_event_date, '')), ''), v_existing.event_date);
  v_merged_latitude       := coalesce(p_latitude, v_existing.latitude);
  v_merged_longitude      := coalesce(p_longitude, v_existing.longitude);
  v_merged_location_label := coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), v_existing.location_label);
  v_merged_youtube_url    := coalesce(nullif(btrim(coalesce(p_youtube_url, '')), ''), v_existing.youtube_url);

  -- Validate the MERGED row (all fields after coalescing)
  perform public.findback_validate_post_fields(
    v_merged_type,
    v_merged_title,
    v_merged_description,
    v_merged_category,
    v_merged_event_date,
    v_merged_latitude,
    v_merged_longitude,
    v_merged_location_label,
    v_merged_youtube_url
  );

  update public.item_posts set
    type = v_merged_type,
    title = v_merged_title,
    description = v_merged_description,
    category = v_merged_category,
    event_date = v_merged_event_date,
    latitude = v_merged_latitude,
    longitude = v_merged_longitude,
    location_label = v_merged_location_label,
    youtube_url = v_merged_youtube_url,
    updated_at = v_now
  where id = p_post_id and user_id = v_uid;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) from public, anon;
grant execute on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) to authenticated;

comment on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
) is 'FindBack update post (authenticated owner only); validates the merged row (coalesced new + existing). Null arguments leave fields unchanged.';