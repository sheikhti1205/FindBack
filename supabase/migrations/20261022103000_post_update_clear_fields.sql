-- FindBack — an explicit way to CLEAR an optional field on your own report.
--
-- WHY THIS FILE EXISTS.
-- `public.findback_update_post_client(...)` merges every incoming value into
-- the stored row:
--
--     title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title)
--
-- so a null or an empty argument means "keep what is stored". That is a good
-- default for a partial update, but it means an owner can never EMPTY a
-- field: a location label they no longer want published, or a map pin that
-- was wrong, could only be replaced by a different value, never removed. The
-- editor surface (E1) has to be able to take those away, and today the only
-- way to ask for it is a silent no-op — the client would have to claim it
-- cleared something the server kept.
--
-- WHAT THIS FILE DOES.
-- It replaces the RPC with the SAME ten arguments plus ONE trailing argument:
--
--     p_clear_fields text[] default null
--
-- `p_clear_fields` NAMES the fields to empty. It is null for every existing
-- caller and a null array clears nothing, so the behaviour of every existing
-- call is byte-identical to the shipped function. The only way to empty a
-- field is to pass its name explicitly — an existing caller cannot trigger a
-- clear by accident, because it does not pass the argument at all.
--
-- SAFETY RULES, all enforced server-side (never client-side):
--   1. Only the fields that are genuinely OPTIONAL in the stored schema can
--      be cleared: 'location_label', 'latitude', 'longitude'.
--   2. 'title', 'description', 'category', 'event_date' and 'type' are
--      REQUIRED on every report — the editor cannot leave one of them empty
--      — so asking to clear one is REFUSED with a readable error instead of
--      silently doing nothing.
--   3. An unknown name is REFUSED. A typo can never widen the blast radius.
--   4. The coordinates are ONE field: naming either clears both, and a call
--      that asks to clear the coordinates while also supplying coordinates is
--      REFUSED (a half-specified pin is not a state the schema has).
--   5. An explicit value always beats a clear request for the same field:
--      typed data is never discarded.
--
-- VALIDATION IS THE DEPLOYED RULE, UNCHANGED. The function that is LIVE on
-- the hosted project is the one re-created by
-- 20260919000000_validation_alignment.sql, and THAT function validates the
-- MERGED row — the values the row will actually have after the caller's
-- arguments are coalesced with the stored ones:
--
--     perform public.findback_validate_post_fields(
--       v_merged_type, v_merged_title, v_merged_description, v_merged_category,
--       v_merged_event_date, v_merged_latitude, v_merged_longitude,
--       v_merged_location_label, v_merged_youtube_url
--     );
--
-- This migration keeps that rule exactly as the deployed function has it, and
-- it applies it to the merged values AS THEY ARE AFTER the clear request is
-- honoured. The clear changes only three optional fields, and the validator
-- accepts an empty location label and empty coordinates (both are optional in
-- the stored schema), so the clear cannot be refused by the validator.
--
-- The merged row is what gets written, so the merged row is what gets
-- validated. An older draft of this file validated only the incoming
-- arguments and only when a type was supplied; that was the PRE-20260919000000
-- rule, it was weaker than the deployed one, and it is not what ships here.
--
-- FORWARD-ONLY. This file drops ONE function and re-creates it with one
-- extra argument; PostgreSQL cannot add an argument to an existing function,
-- so the drop is unavoidable. The drop is guarded (`if exists`), names the
-- exact ten-argument signature it replaces, and is followed in the same
-- transaction by the re-create. No table, column, row, grant or policy
-- outside that one function is touched: this file deletes no data and
-- rewrites no data. Every statement is idempotent, so re-running it changes
-- nothing.
--
-- SECURITY IS UNCHANGED. The function stays SECURITY INVOKER: the caller
-- keeps writing through their own column grants and the owner-scoped RLS
-- policy `item_posts_update_own`, and the row is still selected and updated
-- under `id = p_post_id and user_id = auth.uid()::text`. A caller who does
-- not own the report still gets the same refusal (42501).
--
-- LIVE-PENDING. This file has NOT been applied to the hosted project.
-- Verification pointer: supabase/tests/verify_20261022103000_post_update_clear_fields.sql
-- Static guard: supabase/tests/post_update_clear_fields_parity.test.mjs

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the ten-argument function (guarded, exact signature).
-- ---------------------------------------------------------------------------
drop function if exists public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text
);

-- ---------------------------------------------------------------------------
-- 2. Re-create it with the explicit clear argument.
-- ---------------------------------------------------------------------------
create function public.findback_update_post_client(
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
  v_requested text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- The clear request is read BEFORE the row is touched, so a refused name
  -- never leaves a half-applied update behind.
  if p_clear_fields is not null then
    foreach v_requested in array p_clear_fields loop
      v_requested := lower(btrim(coalesce(v_requested, '')));
      if v_requested = 'location_label' then
        v_clear_location := true;
      elsif v_requested = 'latitude' or v_requested = 'longitude' then
        v_clear_coords := true;
      elsif v_requested = 'type'
         or v_requested = 'title'
         or v_requested = 'description'
         or v_requested = 'category'
         or v_requested = 'event_date' then
        -- Rule 2: these are required on every report — the editor cannot
        -- leave one of them empty. Refusing the clear request says so in the
        -- caller's own words instead of failing later with a confusing
        -- error about a field the caller never touched.
        raise exception 'Field % is required on every report and cannot be cleared', v_requested
          using errcode = '22023';
      else
        -- Rule 3: an unknown name is a mistake, never a silent no-op.
        raise exception 'Unknown field to clear: %', v_requested using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Rule 4: the coordinates are one field. A call that both clears and
  -- supplies them is contradictory, and half a pin is not a stored state.
  if v_clear_coords and (p_latitude is not null or p_longitude is not null) then
    raise exception 'Cannot clear the location coordinates and set new coordinates in the same call'
      using errcode = '22023';
  end if;

  -- Fetch existing row to build the merged values for the WRITE (the same
  -- keep-old merge the shipped function performs inside its UPDATE).
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
  v_merged_latitude       := case when v_clear_coords then null else coalesce(p_latitude, v_existing.latitude) end;
  v_merged_longitude      := case when v_clear_coords then null else coalesce(p_longitude, v_existing.longitude) end;
  -- Rule 5: an explicit value beats a clear request for the same field, so
  -- typed data is never discarded.
  v_merged_location_label := case
    when v_clear_location and nullif(btrim(coalesce(p_location_label, '')), '') is null then null
    else coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), v_existing.location_label)
  end;
  v_merged_youtube_url    := coalesce(nullif(btrim(coalesce(p_youtube_url, '')), ''), v_existing.youtube_url);

  -- VALIDATION IS THE DEPLOYED RULE: the MERGED row is validated, exactly as
  -- the live function (20260919000000_validation_alignment.sql) validates it.
  -- The merged values above already carry the clear request, so the validator
  -- sees the row as it will be stored. It runs before the UPDATE, so a
  -- refused edit leaves the stored row untouched.
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
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) from public, anon;
grant execute on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) to authenticated;

comment on function public.findback_update_post_client(
  text, text, text, text, text, text, double precision, double precision, text, text, text[]
) is $cmt$FindBack update post (authenticated owner only); validates the MERGED row (the values the row will have after the caller's arguments are coalesced with the stored ones), exactly as the deployed function always has, so a value that would not satisfy the validator is never written. Null arguments leave fields unchanged. p_clear_fields (text[], default null) NAMES the optional fields to empty: only 'location_label', 'latitude' and 'longitude' can be cleared, the coordinates are one field (naming either clears both, and clearing while supplying coordinates is refused), required fields ('type', 'title', 'description', 'category', 'event_date') and unknown names are refused with 22023, an explicit value beats a clear request for the same field, and a null array (every existing caller) clears nothing at all.$cmt$;

commit;
