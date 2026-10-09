-- FindBack — profile identity (post-v1 W1): editable display name / bio /
-- location label, plus the public profile lookup extension.
--
-- ADDITIVE ONLY. The Supabase GitHub integration auto-applies migrations on
-- push, so this file must be safe to run once against the live schema: no
-- column drops, no row rewrites, no user/auth data deletion. Existing rows get
-- NULL for the new nullable columns, which every reader already treats as
-- "unset".
--
-- Privacy is unchanged: email and phone stay unreadable by clients. The only
-- new client-visible fields are the public identity columns below.

-- ---------------------------------------------------------------------------
-- 1. Additive identity columns (nullable). display_name already exists from
--    20261009000000; bio and location_label are new.
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists bio text;
alter table public.users add column if not exists location_label text;

-- Extend the safe authenticated column grant. Still no email/phone/updated_at.
grant select (bio, location_label) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Self-service profile update RPC.
--    SECURITY DEFINER because clients hold NO table UPDATE privilege (profile
--    rows stay trigger/RPC-owned). Locked search_path; the caller is resolved
--    from the session via public.findback_uid(), never a parameter, so one
--    account can never write another's profile. Blank input clears to NULL and
--    every field is length-bounded server-side, mirroring the client.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(
  p_display_name text,
  p_bio text,
  p_location_label text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     text := public.findback_uid();
  v_display text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_bio     text := nullif(btrim(coalesce(p_bio, '')), '');
  v_loc     text := nullif(btrim(coalesce(p_location_label, '')), '');
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_display is null or char_length(v_display) > 80 then
    raise exception 'invalid display name' using errcode = '22023';
  end if;
  if v_bio is not null and char_length(v_bio) > 280 then
    raise exception 'invalid bio' using errcode = '22023';
  end if;
  if v_loc is not null and char_length(v_loc) > 60 then
    raise exception 'invalid location' using errcode = '22023';
  end if;

  update public.users
     set display_name   = v_display,
         bio            = v_bio,
         location_label = v_loc,
         updated_at     = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_profile(text, text, text) from public;
revoke execute on function public.update_my_profile(text, text, text) from anon;
grant execute on function public.update_my_profile(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Public profile lookup now returns the new safe identity columns.
--    The OUT row type changes, so the function is dropped and recreated
--    (CREATE OR REPLACE cannot change a table-returning signature). No user
--    data is touched — the lookup is recomputed from public.users. email and
--    phone remain excluded; verification flags are public (already exposed in
--    the feed author projection), stored here as integer 0/1.
-- ---------------------------------------------------------------------------
drop function if exists public.public_profile_by_username(text);
create function public.public_profile_by_username(p_username text)
returns table (
  id text,
  username text,
  avatar_url text,
  email_verified boolean,
  phone_verified boolean,
  display_name text,
  bio text,
  location_label text,
  created_at text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id,
         u.username,
         u.avatar_url,
         coalesce(u.email_verified, 0) <> 0,
         coalesce(u.phone_verified, 0) <> 0,
         u.display_name,
         u.bio,
         u.location_label,
         u.created_at
    from public.users u
   where lower(u.username) = lower(btrim(p_username))
   limit 1
$$;

revoke all on function public.public_profile_by_username(text) from public;
revoke execute on function public.public_profile_by_username(text) from anon;
grant execute on function public.public_profile_by_username(text) to anon, authenticated;
