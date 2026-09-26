-- FindBack — additive category taxonomy expansion (Report P3).
--
-- STATUS: STAGED PROPOSAL — NOT APPLIED. Owner approval + staging dry run are
-- required before this ever runs against a live database. It is intentionally
-- additive and forward-only: no enum rewrite, no rename of existing rows.
--
-- Scope: ONLY the category whitelist branch of
-- public.findback_validate_post_fields is widened from the eight released
-- canonical strings to the 25 proposed canonical strings. The function body,
-- signature, security invoker setting, search_path, date/YouTube/location
-- validation and all grants are preserved exactly as in
-- 20260919000000_validation_alignment.sql.
--
-- Rollback: re-apply 20260919000000_validation_alignment.sql. Existing rows
-- using the original eight strings remain valid either way.
--
-- Client release gate: packages/shared/src/categories.ts keeps
-- RELEASED_CATEGORIES at the original eight until this migration is applied,
-- so clients cannot submit a doomed category (R-051/R-052).

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
    'Books & Stationery', 'Clothing', 'Accessories & Jewelry', 'Other',
    'Phones & Tablets', 'Computers & Accessories', 'Audio & Wearables',
    'Cameras & Photography', 'Watches & Eyewear', 'Footwear', 'Personal Care',
    'Tools & Equipment', 'Office Supplies', 'Umbrellas & Bottles',
    'Household Items', 'Sports & Fitness', 'Toys & Games', 'Travel & Luggage',
    'Vehicle Accessories', 'Medical & Health Items', 'Pet Accessories'
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
