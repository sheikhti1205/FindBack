-- FBX-022 server mirror: exact Storage host bind on avatar URL RPCs.
--
-- Client (`services/avatar.ts isAvatarStorageUrl`) already fail-closes on
-- lookalike hosts. The server RPCs below previously accepted any https URL
-- containing the `/findback-images/...` marker, so
-- `https://evil.example/findback-images/avatars/<uid>/x.jpg` passed shape
-- checks. This migration re-replaces both RPCs (CREATE OR REPLACE, same
-- signatures/grants — additive, no applied migration edited) with the exact
-- discipline: host must be a single-label `<project-ref>.supabase.co`, path
-- must start with
-- `/storage/v1/object/public/findback-images/avatars/<caller-uid>/` followed
-- by an object name, no `..`, no encoded dots. Behavior otherwise unchanged.
--
-- LIVE-PENDING (owner-deferred): verify on the live project with
-- `supabase/tests/verify_20261012030000_avatar_host_bind.sql`
-- (lookalike-host/other-uid/traversal/http/foreign-bucket cases).

-- ---------------------------------------------------------------------------
-- Shared host+path predicate (IMMUTABLE so CHECKs/RPCs share one truth).
-- Returns true only for an https URL on a single-label *.supabase.co host
-- whose path opens with the caller's exact public avatar prefix.
-- ---------------------------------------------------------------------------
create or replace function public.is_own_avatar_public_url(
  p_url text,
  p_uid text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_host text;
  v_path text;
  v_prefix text;
begin
  if p_url is null or p_uid is null then
    return false;
  end if;
  if char_length(p_url) > 2048 or char_length(p_uid) > 128 then
    return false;
  end if;
  v_host := substring(p_url from '^https://([^/]+)');
  if v_host is null then
    return false;
  end if;
  -- Single-label project ref only: `a.b.supabase.co` and
  -- `x.supabase.co.evil.com` both fail (the latter never matches the anchor).
  if lower(v_host) !~ '^[a-z0-9-]+\.supabase\.co$' then
    return false;
  end if;
  v_path := substring(p_url from '^https://[^/]+(/.*)$');
  if v_path is null then
    return false;
  end if;
  v_prefix := '/storage/v1/object/public/findback-images/avatars/' || p_uid || '/';
  if position(v_prefix in v_path) <> 1 then
    return false;
  end if;
  -- An object name must follow the prefix; no traversal, raw or encoded.
  if char_length(v_path) <= char_length(v_prefix) then
    return false;
  end if;
  if position('..' in v_path) > 0 then
    return false;
  end if;
  if position('%2e' in lower(v_path)) > 0 then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.is_own_avatar_public_url(text, text) from public;
grant execute on function public.is_own_avatar_public_url(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_my_avatar: same contract as 20261010000000 plus the host bind.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_avatar(
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    text := public.findback_uid();
  v_avatar text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if v_avatar is not null then
    if not public.is_own_avatar_public_url(v_avatar, v_uid) then
      raise exception 'invalid avatar url' using errcode = '22023';
    end if;
  end if;

  update public.users
     set avatar_url = v_avatar,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_avatar(text) from public;
revoke execute on function public.update_my_avatar(text) from anon;
grant execute on function public.update_my_avatar(text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_my_avatar_by_key: same contract as 20261012000000 plus the URL
-- host bind (key-shape + object-existence checks unchanged).
-- ---------------------------------------------------------------------------
create or replace function public.update_my_avatar_by_key(
  p_object_key text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   text := public.findback_uid();
  v_key   text := nullif(btrim(coalesce(p_object_key, '')), '');
  v_url   text := nullif(btrim(coalesce(p_avatar_url, '')), '');
  v_parts text[];
  v_file  text;
  v_exists boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if v_key is null and v_url is null then
    update public.users
       set avatar_url = null,
           updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     where id = v_uid;
    if not found then
      raise exception 'profile not found' using errcode = 'P0002';
    end if;
    return;
  end if;

  if v_key is null or v_url is null then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if char_length(v_key) > 512 or char_length(v_url) > 2048 then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  if position('..' in v_key) > 0 then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  v_parts := string_to_array(v_key, '/');
  if array_length(v_parts, 1) <> 3
     or v_parts[1] <> 'avatars'
     or v_parts[2] <> v_uid then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  v_file := v_parts[3];
  if v_file !~* '^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp)$' then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;
  -- Exact host+path bind replaces the old substring marker check.
  if not public.is_own_avatar_public_url(v_url, v_uid) then
    raise exception 'invalid avatar key' using errcode = '22023';
  end if;

  select exists(
    select 1 from storage.objects o
     where o.bucket_id = 'findback-images'
       and o.name = v_key
  ) into v_exists;
  if not coalesce(v_exists, false) then
    raise exception 'avatar object not found' using errcode = '22023';
  end if;

  update public.users
     set avatar_url = v_url,
         updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   where id = v_uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_avatar_by_key(text, text) from public;
revoke execute on function public.update_my_avatar_by_key(text, text) from anon;
grant execute on function public.update_my_avatar_by_key(text, text) to authenticated;
