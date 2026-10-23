-- Forward-only extension of 20261022103000. No applied migration is edited.
-- Same eleven-argument RPC, invoker/RLS/column grants, validator and ownership
-- guard. Only youtube_url joins the explicit optional-field clear allowlist.
-- Omitted/null clear arrays keep old partial-update behavior. A nonempty
-- explicit replacement wins over clear, and the MERGED row is validated.
-- LIVE-PENDING: independent payload review BEFORE commit/push (push applies).
-- Local behavior: supabase/tests/verify_20261023190000_post_update_youtube_clear.sql
begin;

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
  p_youtube_url text default null,
  p_clear_fields text[] default null
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
  v_clear_location boolean := false;
  v_clear_coords boolean := false;
  v_clear_youtube boolean := false;
  v_requested text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_clear_fields is not null then
    foreach v_requested in array p_clear_fields loop
      v_requested := lower(btrim(coalesce(v_requested, '')));
      if v_requested = 'location_label' then
        v_clear_location := true;
      elsif v_requested = 'latitude' or v_requested = 'longitude' then
        v_clear_coords := true;
      elsif v_requested = 'youtube_url' then
        v_clear_youtube := true;
      elsif v_requested = 'type'
         or v_requested = 'title'
         or v_requested = 'description'
         or v_requested = 'category'
         or v_requested = 'event_date' then
        raise exception 'Field % is required on every report and cannot be cleared', v_requested
          using errcode = '22023';
      else
        raise exception 'Unknown field to clear: %', v_requested using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_clear_coords and (p_latitude is not null or p_longitude is not null) then
    raise exception 'Cannot clear the location coordinates and set new coordinates in the same call'
      using errcode = '22023';
  end if;

  select type, title, description, category, event_date, latitude, longitude, location_label, youtube_url
    into v_existing
    from public.item_posts
   where id = p_post_id and user_id = v_uid;

  if not found then
    raise exception 'Post not found or you do not own it' using errcode = '42501';
  end if;

  v_merged_type           := coalesce(p_type, v_existing.type);
  v_merged_title          := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_existing.title);
  v_merged_description    := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_existing.description);
  v_merged_category       := coalesce(p_category, v_existing.category);
  v_merged_event_date     := coalesce(nullif(btrim(coalesce(p_event_date, '')), ''), v_existing.event_date);
  v_merged_latitude       := case when v_clear_coords then null else coalesce(p_latitude, v_existing.latitude) end;
  v_merged_longitude      := case when v_clear_coords then null else coalesce(p_longitude, v_existing.longitude) end;
  v_merged_location_label := case
    when v_clear_location and nullif(btrim(coalesce(p_location_label, '')), '') is null then null
    else coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), v_existing.location_label)
  end;
  v_merged_youtube_url := case
    when v_clear_youtube and nullif(btrim(coalesce(p_youtube_url, '')), '') is null then null
    else coalesce(nullif(btrim(coalesce(p_youtube_url, '')), ''), v_existing.youtube_url)
  end;

  perform public.findback_validate_post_fields(
    v_merged_type, v_merged_title, v_merged_description, v_merged_category,
    v_merged_event_date, v_merged_latitude, v_merged_longitude,
    v_merged_location_label, v_merged_youtube_url
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
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) from public, anon;
grant execute on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) to authenticated;
comment on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) is 'Authenticated owner update, SECURITY INVOKER, validates merged row. Null arguments keep stored values. p_clear_fields explicitly clears optional location_label, latitude/longitude (together), or youtube_url. Nonempty text replacement wins over clear. Required/unknown clear names and contradictory coordinate writes are refused.';

commit;
